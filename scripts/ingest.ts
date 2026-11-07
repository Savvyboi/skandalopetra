import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HazardFeature,
  HazardFeatureCollection,
} from "../src/types/schema.ts";
import { fetchAwcWeatherHazards } from "./parsers/awcWeather.ts";
import { fetchFaaNotamHazards } from "./parsers/faaNotam.ts";
import { fetchNgaMaritimeHazards } from "./parsers/ngaMaritime.ts";

const USER_AGENT = "GlobalHazardTracker/1.0 (+https://github.com)";

async function loadExistingArchive(
  repoOwnerAndName: string,
  localFallbackPath: string
): Promise<Map<string, HazardFeature>> {
  const archive = new Map<string, HazardFeature>();
  const archiveUrl = `https://raw.githubusercontent.com/${repoOwnerAndName}/data-feed/alerts.geojson`;

  try {
    const res = await fetch(archiveUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });

    if (res.ok) {
      const data = (await res.json()) as Partial<HazardFeatureCollection>;
      if (Array.isArray(data.features)) {
        for (const feat of data.features) {
          if (feat?.properties?.id) {
            archive.set(feat.properties.id, feat);
          }
        }
        console.log(
          `[ingest] Loaded ${archive.size} cached features from ${archiveUrl}`
        );
        return archive;
      }
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
    const rawLocal = await fs.readFile(localFallbackPath, "utf8");
    const parsed = JSON.parse(rawLocal) as Partial<HazardFeatureCollection>;
    if (Array.isArray(parsed.features)) {
      for (const feat of parsed.features) {
        if (feat?.properties?.id) {
          archive.set(feat.properties.id, feat);
        }
      }
      console.log(
        `[ingest] Loaded ${archive.size} cached features from local ${localFallbackPath}`
      );
    }
  } catch {
    // No local cache yet — start fresh
  }

  return archive;
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

  console.log(`[ingest] Starting hazard ingestion at ${new Date(now * 1000).toISOString()}`);

  const featureMap = await loadExistingArchive(repoOwnerAndName, outPath);

  const parserJobs = await Promise.allSettled([
    fetchAwcWeatherHazards(now),
    fetchNgaMaritimeHazards(now),
    fetchFaaNotamHazards(now),
  ]);

  const parserNames = ["awcWeather", "ngaMaritime", "faaNotam"];
  parserJobs.forEach((result, idx) => {
    const name = parserNames[idx];
    if (result.status === "fulfilled") {
      for (const feature of result.value) {
        if (feature?.properties?.id && feature.geometry) {
          featureMap.set(feature.properties.id, feature);
        }
      }
    } else {
      console.warn(
        `[ingest] Parser ${name} rejected (retaining cached records):`,
        result.reason
      );
    }
  });

  const activeFeatures: HazardFeature[] = [];
  for (const feature of featureMap.values()) {
    if (feature.properties.validTo >= sevenDaysAgo) {
      activeFeatures.push(feature);
    }
  }

  const countsByDomain = { notam: 0, maritime: 0, weather: 0 };
  for (const f of activeFeatures) {
    countsByDomain[f.properties.domain] =
      (countsByDomain[f.properties.domain] ?? 0) + 1;
  }

  const collection: HazardFeatureCollection = {
    type: "FeatureCollection",
    metadata: {
      generatedAt: now,
      totalFeatures: activeFeatures.length,
    },
    features: activeFeatures,
  };

  await fs.mkdir(distDataDir, { recursive: true });
  const serialized = JSON.stringify(collection);
  await fs.writeFile(outPath, serialized, "utf8");

  await fs.mkdir(path.dirname(publicFallbackPath), { recursive: true });
  await fs.copyFile(outPath, publicFallbackPath);

  const sizeMb = (Buffer.byteLength(serialized, "utf8") / (1024 * 1024)).toFixed(
    2
  );
  console.log(
    `[ingest] Wrote ${activeFeatures.length} features (${sizeMb} MB) -> notam=${countsByDomain.notam}, maritime=${countsByDomain.maritime}, weather=${countsByDomain.weather}`
  );
}

main().catch((err) => {
  console.error("[ingest] Fatal pipeline error:", err);
  process.exit(1);
});
