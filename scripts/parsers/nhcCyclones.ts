import type { HazardFeature } from "../../src/types/schema.ts";

const NHC = "https://www.nhc.noaa.gov";
const FEED = `${NHC}/CurrentStorms.json`;
const ISSUER = "NOAA National Hurricane Center";
const FRESHNESS_HOURS = 9;
const BASINS = {
  al: { name: "Atlantic basin", issuer: ISSUER },
  ep: { name: "Eastern North Pacific", issuer: ISSUER },
  cp: { name: "Central North Pacific", issuer: "NOAA Central Pacific Hurricane Center" },
} as const;

const CLASSIFICATIONS: Record<string, string> = {
  TD: "Tropical Depression",
  TS: "Tropical Storm",
  HU: "Hurricane",
  MH: "Major Hurricane",
  SD: "Subtropical Depression",
  SS: "Subtropical Storm",
  PT: "Post-Tropical Cyclone",
  PTC: "Potential Tropical Cyclone",
  EX: "Extratropical Cyclone",
  LO: "Remnant Low",
};

interface StormRow {
  id?: string;
  name?: string;
  classification?: string;
  latitudeNumeric?: number;
  longitudeNumeric?: number;
  lastUpdate?: string;
  intensity?: number | string;
  pressure?: number | string;
  movementDir?: number;
  movementSpeed?: number;
  publicAdvisory?: { advNum?: string; url?: string } | null;
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function advisoryUrl(stormId: string, advisory: StormRow["publicAdvisory"]): string {
  const number = advisory?.advNum;
  if (typeof number === "string" && /^\d{3}$/.test(number)) {
    const year = stormId.slice(4);
    return `${NHC}/archive/${year}/${stormId.slice(0, 4)}/${stormId}.public.${number}.shtml`;
  }
  const link = advisory?.url;
  if (typeof link === "string" && /^https:\/\/www\.nhc\.noaa\.gov\/text\/[a-z0-9]+\.shtml$/i.test(link)) return link;
  return `${NHC}/cyclones/`;
}

function normalizeStorm(row: StormRow, nowSec: number): { stormPrefix: string; feature: HazardFeature } | null {
  const { id, name, classification, lastUpdate, latitudeNumeric, longitudeNumeric } = row;
  if (typeof id !== "string" || typeof name !== "string" || !name.trim()) return null;
  const match = /^(al|ep|cp)\d{2}\d{4}$/.exec(id);
  if (!match || typeof classification !== "string" || !/^[A-Z]{2,3}$/.test(classification)) return null;
  if (typeof lastUpdate !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(lastUpdate)) return null;
  const issuedAt = Math.floor(Date.parse(lastUpdate) / 1000);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0 || issuedAt > nowSec + 15 * 60) return null;
  if (typeof latitudeNumeric !== "number" || !Number.isFinite(latitudeNumeric) || Math.abs(latitudeNumeric) > 90 ||
      typeof longitudeNumeric !== "number" || !Number.isFinite(longitudeNumeric) || Math.abs(longitudeNumeric) > 180) return null;

  const basin = BASINS[match[1] as keyof typeof BASINS];
  const stormPrefix = `NHC-TC-${id}-`;
  const type = CLASSIFICATIONS[classification] ?? `Cyclone (${classification})`;
  const title = `${type} ${name.trim()}`;
  const intensity = nonNegativeNumber(row.intensity);
  const pressure = nonNegativeNumber(row.pressure);
  const heading = nonNegativeNumber(row.movementDir);
  const speed = nonNegativeNumber(row.movementSpeed);
  const rawText = [
    `${title} · ${id.toUpperCase()}`,
    `Storm center at ${new Date(issuedAt * 1000).toISOString()}: ${latitudeNumeric}°, ${longitudeNumeric}°`,
    intensity === undefined ? "" : `Maximum sustained winds: ${intensity} kt`,
    pressure === undefined || pressure === 0 ? "" : `Minimum central pressure: ${pressure} hPa`,
    speed === undefined || heading === undefined || heading > 360 ? "" : `Movement: ${heading}° at ${speed} mph`,
  ].filter(Boolean).join("\n");

  return {
    stormPrefix,
    feature: {
      type: "Feature",
      geometry: { type: "Point", coordinates: [longitudeNumeric, latitudeNumeric] },
      properties: {
        id: `${stormPrefix}${issuedAt}`,
        domain: "weather",
        subType: "TROPICAL CYCLONE",
        severity: classification === "HU" || classification === "MH" || (intensity ?? 0) >= 64 ? "danger" : "warning",
        title,
        rawText,
        stationOrArea: `${basin.name} · ${id.toUpperCase()}`,
        issuer: basin.issuer,
        country: basin.name,
        region: "High Seas",
        areaSqKm: 0,
        durationHours: FRESHNESS_HOURS,
        issuedAt,
        validFrom: issuedAt,
        validTo: issuedAt + FRESHNESS_HOURS * 3600,
        sourceUrl: advisoryUrl(id, row.publicAdvisory),
        geometryNote: "Reported storm-center position. The advisory describes forecast winds, affected areas, and warnings.",
        validityNote: `Skandalopetra shows this position for up to ${FRESHNESS_HOURS} hours, until a newer position arrives, or until NOAA removes the storm from its active list.`,
      },
    },
  };
}

export async function fetchNhcCycloneHazards(nowSec: number): Promise<{
  features: HazardFeature[];
  activeStormPrefixes?: ReadonlySet<string>;
}> {
  const response = await fetch(FEED, {
    headers: {
      "User-Agent": "GlobalHazardTracker/1.0 (+https://github.com)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`NHC CurrentStorms returned HTTP ${response.status}`);
  const body: { activeStorms?: Array<StormRow | null> } | null = await response.json();
  if (!Array.isArray(body?.activeStorms)) throw new Error("NHC response lacks an activeStorms array");

  const latest = new Map<string, HazardFeature>();
  let complete = true;
  for (const row of body.activeStorms) {
    const normalized = row && normalizeStorm(row, nowSec);
    if (!normalized) {
      complete = false;
      continue;
    }
    const { stormPrefix, feature } = normalized;
    const previous = latest.get(stormPrefix);
    if (!previous || feature.properties.issuedAt >= previous.properties.issuedAt) latest.set(stormPrefix, feature);
  }
  if (!complete) console.warn("[nhcCyclones] Invalid storm row. The snapshot will not retire missing storms.");
  console.log(`[nhcCyclones] Parsed ${latest.size} current storm-center positions`);
  return {
    features: [...latest.values()],
    activeStormPrefixes: complete ? new Set(latest.keys()) : undefined,
  };
}
