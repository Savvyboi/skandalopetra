import type { Geometry, MultiPolygon, Polygon } from "geojson";
import type { HazardFeature } from "../../src/types/schema.ts";
import { computeDurationHours, computeGeometryAreaSqKm } from "../utils/geometry.ts";

const API = "https://api.weather.gov";
const REFERENCE_MAP = "https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer";
const USER_AGENT = "GlobalHazardTracker/1.0 (+https://github.com/Savvyboi/skandalopetra)";
const ID_PREFIX = "NWS-CAP-";
const MARINE_EVENTS = new Set([
  "Gale Warning", "Hazardous Seas Warning", "Heavy Freezing Spray Warning", "Hurricane Force Wind Warning",
  "Marine Weather Statement", "Special Marine Warning", "Storm Warning",
]);
const RELEVANT_EVENTS = new Set([
  ...MARINE_EVENTS,
  "Coastal Flood Warning", "Dust Storm Warning", "Flash Flood Warning", "Flood Warning",
  "High Surf Warning", "Hurricane Warning", "Severe Thunderstorm Warning", "Storm Surge Warning",
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
    geocode?: { UGC?: string[] };
  };
}

function toUnixSeconds(value: string | null | undefined): number {
  return value ? Math.floor(Date.parse(value) / 1000) : NaN;
}

function marineZoneCodes(record: CapFeature): string[] {
  const { event, geocode, status, messageType } = record?.properties ?? {};
  if (record?.geometry || status !== "Actual" || (messageType !== "Alert" && messageType !== "Update") ||
      !event || !MARINE_EVENTS.has(event) || !Array.isArray(geocode?.UGC) ||
      !geocode.UGC.every((code) => typeof code === "string" && /^[A-Z]{3}\d{3}$/.test(code))) return [];
  return [...new Set(geocode.UGC)];
}

function polygonGeometry(geometry: Geometry | null | undefined): geometry is Polygon | MultiPolygon {
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
}

async function fetchMarineZones(codes: string[]): Promise<Map<string, Polygon | MultiPolygon>> {
  const zones = new Map<string, Polygon | MultiPolygon>();
  const requests: Promise<void>[] = [];
  for (let offset = 0; offset < codes.length; offset += 100) {
    const batch = codes.slice(offset, offset + 100);
    // The CAP links often use /zones/forecast even for marine zones. Match official UGC IDs instead.
    for (const layer of [5, 6, 10]) {
      requests.push((async () => {
        const url = new URL(`${REFERENCE_MAP}/${layer}/query`);
        url.search = new URLSearchParams({
          f: "geojson",
          where: `id IN (${batch.map((code) => `'${code}'`).join(",")})`,
          outFields: "id",
          outSR: "4326",
          maxAllowableOffset: "0.003",
          geometryPrecision: "5",
        }).toString();
        const response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(`marine zones layer ${layer} HTTP ${response.status}`);
        const data = await response.json() as {
          type?: string;
          features?: { properties?: { id?: string }; geometry?: Geometry }[];
        };
        if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
          throw new Error(`marine zones layer ${layer} returned invalid GeoJSON`);
        }
        for (const feature of data.features) {
          const id = feature?.properties?.id;
          if (id && batch.includes(id) && polygonGeometry(feature.geometry)) zones.set(id, feature.geometry);
        }
      })());
    }
  }
  for (const result of await Promise.allSettled(requests)) {
    if (result.status === "rejected") console.warn("[nwsAlerts] Marine zone lookup unavailable:", result.reason);
  }
  return zones;
}

function geometryForZones(codes: string[], zones: Map<string, Polygon | MultiPolygon>): Geometry | undefined {
  if (!codes.length || !codes.every((code) => zones.has(code))) return undefined;
  const geometries = codes.map((code) => zones.get(code)!);
  return geometries.length === 1 ? geometries[0] : { type: "GeometryCollection", geometries };
}

export async function fetchNwsAlerts(
  onSnapshot?: (idPrefix: string, activeIds: ReadonlySet<string>) => void
): Promise<HazardFeature[]> {
  const url = new URL("/alerts/active", API);
  url.searchParams.set("status", "actual");
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
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
  const codesByRecord = new Map(data.features.map((record) => [record, marineZoneCodes(record)]));
  const marineZones = await fetchMarineZones([...new Set([...codesByRecord.values()].flat())].sort());
  let zoneBacked = 0;
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

    const zoneGeometry = !record.geometry ? geometryForZones(codesByRecord.get(record) ?? [], marineZones) : undefined;
    const geometry = polygonGeometry(record.geometry) ? record.geometry : zoneGeometry;
    if (!geometry) continue;
    const areaSqKm = computeGeometryAreaSqKm(geometry);
    const issuedAt = toUnixSeconds(p.sent);
    const validFrom = toUnixSeconds(p.onset ?? p.effective ?? p.sent);
    const validTo = toUnixSeconds(p.ends ?? p.expires);
    if (!(areaSqKm > 0) || !Number.isFinite(issuedAt) || !(validTo > validFrom)) continue;
    if (zoneGeometry) zoneBacked++;
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
        ...(zoneGeometry ? { geometryNote: "Simplified boundaries of the affected NOAA marine forecast zones." } : {}),
      },
    });
  }
  if (complete) onSnapshot?.(ID_PREFIX, activeIds);
  console.log(`[nwsAlerts] Parsed ${features.length} NOAA/NWS alerts (${zoneBacked} mapped to marine forecast zones)`);
  return features;
}
