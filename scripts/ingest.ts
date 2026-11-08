import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HazardFeature,
  HazardFeatureCollection,
} from "../src/types/schema.ts";
import { fetchAwcWeatherHazards } from "./parsers/awcWeather.ts";
import { fetchFaaNotamHazards } from "./parsers/faaNotam.ts";
import { fetchFaaNasStatusHazards } from "./parsers/faaNasStatus.ts";
import { fetchGlobalIcaoNotams } from "./parsers/globalNotam.ts";
import { fetchNgaMaritimeHazards } from "./parsers/ngaMaritime.ts";
import { fetchKystverketHazards } from "./parsers/kystverket.ts";
import { fetchNwsAlerts } from "./parsers/nwsAlerts.ts";
import { fetchDeceaNotamHazards } from "./parsers/deceaNotam.ts";
import { fetchCcgNavwarnHazards } from "./parsers/ccgNavwarn.ts";
import { fetchTraficomNavwarnHazards } from "./parsers/traficomNavwarn.ts";
import { fetchNhcCycloneHazards } from "./parsers/nhcCyclones.ts";
import { fetchEcccWeatherAlerts } from "./parsers/ecccWeatherAlerts.ts";
import { fetchWashingtonVaacHazards } from "./parsers/washingtonVaac.ts";
import { fetchShomPingHazards } from "./parsers/shomPing.ts";
import {
  closePolygonRings,
  computeDurationHours,
  computeGeometryAreaSqKm,
} from "./utils/geometry.ts";
import {
  resolveIcaoMetadata,
  resolveNavAreaMetadata,
} from "./utils/icaoRegions.ts";

const USER_AGENT = "GlobalHazardTracker/1.0 (+https://github.com)";

function backfillArchiveFeature(feat: HazardFeature): HazardFeature {
  const p = feat.properties;
  if (p.subType === "TAF") delete p.altitudeMaxFt;
  const geometry = closePolygonRings(feat.geometry);
  if (geometry !== feat.geometry) {
    feat.geometry = geometry;
    p.areaSqKm = computeGeometryAreaSqKm(geometry);
  }
  if (
    p.issuer &&
    p.country &&
    p.region &&
    typeof p.areaSqKm === "number" &&
    typeof p.durationHours === "number"
  ) {
    return feat;
  }

  const meta =
    p.domain === "maritime"
      ? resolveNavAreaMetadata(p.stationOrArea)
      : p.subType === "TFR"
      ? {
          issuer: "FAA (US)",
          country: "United States",
          region: "North America" as const,
        }
      : resolveIcaoMetadata(p.stationOrArea, p.domain);

  return {
    ...feat,
    properties: {
      ...p,
      issuer: p.issuer || meta.issuer,
      country: p.country || meta.country,
      region: p.region || meta.region,
      areaSqKm:
        typeof p.areaSqKm === "number"
          ? p.areaSqKm
          : computeGeometryAreaSqKm(feat.geometry),
      durationHours:
        typeof p.durationHours === "number"
          ? p.durationHours
          : computeDurationHours(p.validFrom, p.validTo),
    },
  };
}

function isLegacyArtifact(feat: HazardFeature): boolean {
  const p = feat.properties;
  return p.id.endsWith("-BULLETIN") ||
    (p.id.startsWith("WMO-NAVAREA-") && !p.id.includes("-ISSUE-"));
}

function readArchive(data: unknown): Map<string, HazardFeature> {
  const collection = data as Partial<HazardFeatureCollection> | null;
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("Invalid archive FeatureCollection");
  }
  const archive = new Map<string, HazardFeature>();
  for (const feature of collection.features) {
    if (isUsableFeature(feature) && !isLegacyArtifact(feature)) {
      archive.set(feature.properties.id, backfillArchiveFeature(feature));
    }
  }
  if (collection.features.length > 0 && archive.size === 0) {
    throw new Error("Archive contains no usable hazard features");
  }
  return archive;
}

function isUsableFeature(feature: HazardFeature | null | undefined): feature is HazardFeature {
  const p = feature?.properties;
  return Boolean(
    feature?.geometry && p?.id &&
    Number.isFinite(p.validFrom) && Number.isFinite(p.validTo) && p.validFrom <= p.validTo
  );
}

function cycloneStormPrefix(id: string): string {
  return id.slice(0, id.lastIndexOf("-") + 1);
}

async function writeFeed(filePath: string, data: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function loadExistingArchive(
  repoOwnerAndName: string,
  localFallbackPath: string
): Promise<Map<string, HazardFeature>> {
  if (process.env.ARCHIVE_FROM_CHECKOUT === "true") {
    try {
      const archive = readArchive(JSON.parse(await fs.readFile(localFallbackPath, "utf8")));
      console.log(`[ingest] Loaded ${archive.size} features from the current data-feed commit`);
      return archive;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw err;
    }
  }

  const archiveUrl = `https://raw.githubusercontent.com/${repoOwnerAndName}/data-feed/alerts.geojson`;
  try {
    const res = await fetch(archiveUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });

    if (res.ok) {
      const archive = readArchive(await res.json());
      console.log(`[ingest] Loaded ${archive.size} cached features from ${archiveUrl}`);
      return archive;
    } else if (res.status === 404) {
      console.log(
        `[ingest] Remote data-feed archive not found yet (404); checking local cache...`
      );
    } else {
      console.warn(
        `[ingest] Remote archive returned HTTP ${res.status}; checking local cache...`
      );
    }
  } catch (err) {
    console.warn(
      "[ingest] Could not fetch remote archive:",
      err instanceof Error ? err.message : err
    );
  }

  try {
    const archive = readArchive(JSON.parse(await fs.readFile(localFallbackPath, "utf8")));
    console.log(`[ingest] Loaded ${archive.size} cached features from the local archive`);
    return archive;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
}

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 86400;
  const repoOwnerAndName =
    process.env.REPO_OWNER_AND_NAME?.trim() || "Savvyboi/skandalopetra";

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "..");
  const distDataDir = path.join(rootDir, "dist-data");
  const outPath = path.join(distDataDir, "alerts.geojson");
  const publicFallbackPath = path.join(rootDir, "public", "alerts.geojson");

  console.log(
    `[ingest] Starting global hazard ingestion at ${new Date(
      now * 1000
    ).toISOString()}`
  );

  const featureMap = await loadExistingArchive(repoOwnerAndName, outPath);

  const snapshots = new Map<string, ReadonlySet<string>>();
  const expiries = new Map<string, number>();
  const stationReports = new Map<string, { issuedAt: number; effectiveAt: number }>();
  const ashAdvisories = new Map<string, number>();
  let activeCyclones: ReadonlySet<string> | undefined;
  const recordSnapshot = (idPrefix: string, activeIds: ReadonlySet<string>) => {
    snapshots.set(idPrefix, activeIds);
  };
  const recordExpiry = (id: string, expiresAt: number) => {
    if (Number.isFinite(expiresAt)) expiries.set(id, Math.min(expiries.get(id) ?? now - 1, expiresAt));
  };

  const jobs = {
    awcWeather: fetchAwcWeatherHazards((product, station, issuedAt, effectiveAt) => {
      const key = `${product}-${station}`;
      if (issuedAt > (stationReports.get(key)?.issuedAt ?? 0)) {
        stationReports.set(key, { issuedAt, effectiveAt });
      }
    }),
    ngaMaritime: fetchNgaMaritimeHazards(now, recordSnapshot),
    faaNotam: fetchFaaNotamHazards(now),
    faaNasStatus: fetchFaaNasStatusHazards(now, recordSnapshot),
    globalNotam: fetchGlobalIcaoNotams(now, recordExpiry),
    deceaNotam: fetchDeceaNotamHazards(now),
    kystverket: fetchKystverketHazards(now, recordSnapshot),
    ccgNavwarn: fetchCcgNavwarnHazards(now, recordSnapshot),
    traficomNavwarn: fetchTraficomNavwarnHazards(now, recordSnapshot),
    shomPing: fetchShomPingHazards(now, recordSnapshot),
    nhcCyclones: fetchNhcCycloneHazards(now).then(({ features, activeStormPrefixes }) => {
      activeCyclones = activeStormPrefixes;
      return features;
    }),
    nwsAlerts: fetchNwsAlerts(recordSnapshot),
    ecccWeather: fetchEcccWeatherAlerts(recordSnapshot),
    washingtonVaac: fetchWashingtonVaacHazards(now, (idPrefix, issuedAt) => {
      ashAdvisories.set(idPrefix, Math.max(issuedAt, ashAdvisories.get(idPrefix) ?? 0));
    }),
  };
  const names = Object.keys(jobs);
  const results = await Promise.allSettled(Object.values(jobs));
  let received = 0;
  results.forEach((result, idx) => {
    if (result.status === "fulfilled") {
      for (const feature of result.value) {
        if (isUsableFeature(feature)) {
          const p = feature.properties;
          const previous = featureMap.get(p.id)?.properties;
          // A stale listing must not reopen an advisory already retired in the archive.
          if ((p.id.startsWith("NHC-TC-") || p.id.startsWith("W-VAAC-ASH-")) && previous && previous.validTo < p.validTo) {
            p.validTo = previous.validTo;
            p.durationHours = computeDurationHours(p.validFrom, p.validTo);
          }
          featureMap.set(p.id, feature);
          received++;
        }
      }
    } else {
      console.warn(
        `[ingest] Parser ${names[idx]} rejected (retaining cached records):`,
        result.reason
      );
    }
  });
  if (received === 0) {
    throw new Error("No usable features returned by any source. Keeping the previous feed.");
  }

  const activeFeatures: HazardFeature[] = [];
  const advisorySeries = new Map<string, HazardFeature["properties"][]>();
  for (const { properties: p } of featureMap.values()) {
    const prefix = p.id.startsWith("NHC-TC-") ? cycloneStormPrefix(p.id) : /^W-VAAC-ASH-\d{6}-/.exec(p.id)?.[0];
    if (!prefix) continue;
    const advisories = advisorySeries.get(prefix);
    if (advisories) advisories.push(p);
    else advisorySeries.set(prefix, [p]);
  }
  for (const [prefix, advisories] of advisorySeries) {
    const issueTimes = new Set(advisories.map((p) => p.issuedAt));
    const newAshAdvisory = ashAdvisories.get(prefix);
    if (newAshAdvisory !== undefined) issueTimes.add(newAshAdvisory);
    const times = [...issueTimes].sort((a, b) => a - b);
    const nextIssue = new Map(times.slice(0, -1).map((time, index) => [time, times[index + 1]]));
    for (const p of advisories) {
      const cutoff = nextIssue.get(p.issuedAt);
      if (cutoff !== undefined) expiries.set(p.id, cutoff - 1);
    }
  }
  for (const feature of featureMap.values()) {
    const p = feature.properties;
    let validTo = Math.min(p.validTo, expiries.get(p.id) ?? p.validTo);
    if (activeCyclones && p.id.startsWith("NHC-TC-") && !activeCyclones.has(cycloneStormPrefix(p.id))) {
      validTo = Math.min(validTo, now - 1);
    }
    if (p.subType === "METAR" || p.subType === "TAF") {
      const report = stationReports.get(`${p.subType}-${p.stationOrArea}`);
      if (report && p.issuedAt < report.issuedAt) validTo = Math.min(validTo, report.effectiveAt - 1);
    }
    for (const [prefix, activeIds] of snapshots) {
      if (p.id.startsWith(prefix) && !activeIds.has(p.id)) validTo = Math.min(validTo, now - 1);
    }
    if (validTo < sevenDaysAgo || validTo < p.validFrom) continue;
    if (validTo !== p.validTo) {
      p.validTo = validTo;
      p.durationHours = computeDurationHours(p.validFrom, validTo);
    }
    activeFeatures.push(feature);
  }

  const countsByDomain = { notam: 0, maritime: 0, weather: 0 };
  const countsByRegion: Record<string, number> = {};
  for (const f of activeFeatures) {
    countsByDomain[f.properties.domain] =
      (countsByDomain[f.properties.domain] ?? 0) + 1;
    countsByRegion[f.properties.region] =
      (countsByRegion[f.properties.region] ?? 0) + 1;
  }

  const collection: HazardFeatureCollection = {
    type: "FeatureCollection",
    metadata: {
      generatedAt: now,
      totalFeatures: activeFeatures.length,
    },
    features: activeFeatures,
  };

  const serialized = JSON.stringify(collection);
  const sizeMiB = Buffer.byteLength(serialized, "utf8") / (1024 * 1024);
  if (sizeMiB > 100) throw new Error("Feed exceeds GitHub's 100 MiB file limit. Keeping the previous feed.");
  if (sizeMiB > 50) console.warn(`[ingest] Feed is ${sizeMiB.toFixed(2)} MiB. GitHub's file limit is 100 MiB.`);
  await writeFeed(outPath, serialized);
  if (process.env.ARCHIVE_FROM_CHECKOUT !== "true") {
    await writeFeed(publicFallbackPath, serialized);
  }

  console.log(
    `[ingest] Wrote ${activeFeatures.length} features (${sizeMiB.toFixed(2)} MiB) -> notam=${countsByDomain.notam}, maritime=${countsByDomain.maritime}, weather=${countsByDomain.weather}`
  );
  console.log(`[ingest] Regional breakdown:`, countsByRegion);
}

main().catch((err) => {
  console.error("[ingest] Fatal pipeline error:", err);
  process.exit(1);
});
