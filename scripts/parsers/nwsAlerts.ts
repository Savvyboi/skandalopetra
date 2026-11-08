import type { Geometry } from "geojson";
import type { HazardFeature } from "../../src/types/schema.ts";
import { computeDurationHours, computeGeometryAreaSqKm } from "../utils/geometry.ts";

const API = "https://api.weather.gov";
const ID_PREFIX = "NWS-CAP-";
const RELEVANT_EVENTS = new Set([
  "Coastal Flood Warning", "Dust Storm Warning", "Flash Flood Warning", "Flood Warning",
  "Gale Warning", "Hazardous Seas Warning", "Heavy Freezing Spray Warning", "High Surf Warning",
  "Hurricane Warning", "Hurricane Force Wind Warning", "Marine Weather Statement",
  "Severe Thunderstorm Warning", "Special Marine Warning", "Storm Warning", "Storm Surge Warning",
  "Tornado Warning", "Tropical Storm Warning", "Tsunami Advisory", "Tsunami Warning", "Tsunami Watch",
]);

interface CapFeature {
  geometry?: Geometry | null;
  properties?: {
    id?: string;
    status?: string;
    messageType?: string;
    event?: string;
    areaDesc?: string;
    senderName?: string;
    headline?: string;
    description?: string;
    instruction?: string;
    severity?: string;
    sent?: string;
    effective?: string;
    onset?: string | null;
    ends?: string | null;
    expires?: string;
  };
}

function toUnixSeconds(value: string | null | undefined): number {
  return value ? Math.floor(Date.parse(value) / 1000) : NaN;
}

export async function fetchNwsAlerts(
  onSnapshot?: (idPrefix: string, activeIds: ReadonlySet<string>) => void
): Promise<HazardFeature[]> {
  const url = new URL("/alerts/active", API);
  url.searchParams.set("status", "actual");
  const response = await fetch(url, {
    headers: {
      "User-Agent": "GlobalHazardTracker/1.0 (+https://github.com/Savvyboi/skandalopetra)",
      Accept: "application/geo+json",
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`NWS CAP returned HTTP ${response.status}`);
  const data = await response.json() as {
    type?: string;
    features?: CapFeature[];
    pagination?: { next?: string };
  };
  if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    throw new Error("NWS CAP did not return a FeatureCollection");
  }

  const features: HazardFeature[] = [];
  const activeIds = new Set<string>();
  let complete = !data.pagination?.next;
  for (const record of data.features) {
    const p = record?.properties;
    if (!p?.id || !p.status || !p.event || !p.messageType) {
      complete = false;
      continue;
    }
    if (p.status !== "Actual" || !RELEVANT_EVENTS.has(p.event)) continue;
    if (p.messageType !== "Alert" && p.messageType !== "Update") continue;
    const id = ID_PREFIX + p.id;
    activeIds.add(id);

    // Many CAP products contain only zone references. Render only supplied warning footprints.
    const geometry = record.geometry;
    if (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon") continue;
    const areaSqKm = computeGeometryAreaSqKm(geometry);
    const issuedAt = toUnixSeconds(p.sent);
    const validFrom = toUnixSeconds(p.onset ?? p.effective ?? p.sent);
    const validTo = toUnixSeconds(p.ends ?? p.expires);
    if (!(areaSqKm > 0) || !Number.isFinite(issuedAt) || !(validTo > validFrom)) continue;
    const rawText = [p.headline, p.description, p.instruction].filter(Boolean).join("\n\n");

    features.push({
      type: "Feature",
      geometry,
      properties: {
        id,
        domain: "weather",
        subType: "NWS ALERT",
        severity: p.severity === "Extreme" || p.severity === "Severe" ? "danger" : "warning",
        title: p.event,
        rawText: rawText || p.event,
        stationOrArea: p.areaDesc,
        issuer: p.senderName || "NOAA National Weather Service",
        country: "United States",
        region: "North America",
        areaSqKm,
        durationHours: computeDurationHours(validFrom, validTo),
        issuedAt,
        validFrom,
        validTo,
        sourceUrl: `${API}/alerts/${encodeURIComponent(p.id)}`,
      },
    });
  }
  if (complete) onSnapshot?.(ID_PREFIX, activeIds);
  console.log(`[nwsAlerts] Parsed ${features.length} NOAA/NWS alerts with warning polygons`);
  return features;
}
