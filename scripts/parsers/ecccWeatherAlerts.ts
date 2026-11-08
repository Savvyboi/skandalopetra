import { createHash } from "node:crypto";
import type { Geometry, MultiPolygon, Polygon } from "geojson";
import type { HazardFeature } from "../../src/types/schema.ts";
import { closePolygonRings, computeDurationHours, computeGeometryAreaSqKm } from "../utils/geometry.ts";

const ENDPOINT = "https://api.weather.gc.ca/collections/weather-alerts/items";
const ID_PREFIX = "ECCC-ALERT-";
const ACTIVE_STATUSES = new Set(["issued", "continued", "updated"]);
const INACTIVE_STATUSES = new Set(["ended", "expired", "cancelled", "canceled"]);

interface AlertRow {
  id?: string;
  geometry?: Geometry | null;
  properties?: {
    alert_type?: string;
    alert_name_en?: string;
    alert_text_en?: string;
    risk_colour_en?: string | null;
    status_en?: string;
    publication_datetime?: string;
    expiration_datetime?: string;
    validity_datetime?: string;
    event_end_datetime?: string | null;
    feature_name_en?: string;
  };
}

interface AlertPage {
  type?: string;
  numberMatched?: number;
  numberReturned?: number;
  links?: { rel?: string; href?: string }[];
  features?: AlertRow[];
}

async function fetchAlertRows(): Promise<AlertRow[]> {
  let url = new URL(`${ENDPOINT}?f=json&lang=en&limit=500`);
  const rows: AlertRow[] = [];
  const seen = new Set<string>();
  let expected: number | undefined;
  for (let page = 0; page < 8; page++) {
    if (seen.has(url.href)) throw new Error("GeoMet returned a cyclic next page");
    seen.add(url.href);
    const response = await fetch(url, {
      headers: { "User-Agent": "GlobalHazardTracker/1.0 (+https://github.com/Savvyboi/skandalopetra)", Accept: "application/geo+json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GeoMet weather alerts returned HTTP ${response.status}`);
    const data = await response.json() as AlertPage | null;
    if (data?.type !== "FeatureCollection" || !Array.isArray(data.features) ||
        !Number.isSafeInteger(data.numberMatched) || data.numberReturned !== data.features.length) {
      throw new Error("GeoMet weather alerts returned an invalid page");
    }
    expected ??= data.numberMatched;
    if (expected !== data.numberMatched) throw new Error("GeoMet changed during pagination");
    rows.push(...data.features);
    const next = data.links?.find((link) => link.rel === "next")?.href;
    if (!next) {
      if (rows.length !== expected || new Set(rows.map((row) => row?.id)).size !== rows.length) {
        throw new Error("GeoMet returned an incomplete or duplicate alert listing");
      }
      return rows;
    }
    url = new URL(next, url);
    if (`${url.origin}${url.pathname}` !== ENDPOINT || url.username || url.password) {
      throw new Error("GeoMet returned an unexpected pagination URL");
    }
  }
  throw new Error("GeoMet weather alerts exceeded the pagination limit");
}

function toUnixSec(value: string | null | undefined): number {
  return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? Math.floor(Date.parse(value) / 1000) : NaN;
}

interface AlertGroup {
  properties: Omit<HazardFeature["properties"], "id" | "areaSqKm" | "stationOrArea" | "sourceUrl">;
  areas: Map<string, { geometry: Polygon | MultiPolygon; name: string }>;
}

export async function fetchEcccWeatherAlerts(
  onSnapshot?: (idPrefix: string, activeIds: ReadonlySet<string>) => void
): Promise<HazardFeature[]> {
  const rows = await fetchAlertRows();
  const groups = new Map<string, AlertGroup>();
  let complete = true;
  for (const row of rows) {
    const p = row?.properties;
    const status = p?.status_en?.toLowerCase() ?? "";
    if (INACTIVE_STATUSES.has(status)) continue;
    const issuedAt = toUnixSec(p?.publication_datetime);
    // Continued alerts can refer to an onset before this version of the bulletin was published.
    const validFrom = p?.validity_datetime ? Math.max(issuedAt, toUnixSec(p.validity_datetime)) : issuedAt;
    // Bulletin expiry is a refresh deadline and can precede the start of a forecast event.
    const validTo = p?.event_end_datetime ? toUnixSec(p.event_end_datetime) : toUnixSec(p?.expiration_datetime);
    const { id, geometry } = row ?? {};
    if (!ACTIVE_STATUSES.has(status) || !id || !p?.alert_name_en || !p.alert_type ||
        !p.alert_text_en?.trim() || !Number.isFinite(issuedAt) || !(validTo > validFrom) ||
        (geometry?.type !== "Polygon" && geometry?.type !== "MultiPolygon")) {
      complete = false;
      continue;
    }
    const colour = p.risk_colour_en?.toLowerCase();
    const type = p.alert_type.toLowerCase();
    const severity = colour === "red" || colour === "orange" ? "danger"
      : colour === "yellow" || type === "warning" || type === "watch" || type === "advisory" ? "warning" : "info";
    const title = colour ? `${colour[0].toUpperCase()}${colour.slice(1)} ${type} · ${p.alert_name_en}` : p.alert_name_en;
    // GeoMet repeats the same bulletin for each area. Group only identical bulletin content and times.
    const bulletinId = id.includes("_") ? id.slice(0, id.indexOf("_")) : id;
    const groupKey = JSON.stringify([bulletinId, title, p.alert_text_en, issuedAt, validFrom, validTo]);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        areas: new Map(),
        properties: {
          domain: "weather", subType: "CANADA WEATHER", severity, title, rawText: p.alert_text_en,
          issuer: "Environment and Climate Change Canada", country: "Canada", region: "North America",
          durationHours: computeDurationHours(validFrom, validTo), issuedAt, validFrom, validTo,
        },
      };
      groups.set(groupKey, group);
    }
    group.areas.set(id, { geometry: closePolygonRings(geometry) as Polygon | MultiPolygon, name: p.feature_name_en ?? "" });
  }

  const features: HazardFeature[] = [];
  for (const [groupKey, group] of groups) {
    const areaIds = [...group.areas.keys()].sort();
    const areas = areaIds.map((id) => group.areas.get(id)!);
    const geometry: Geometry = areas.length === 1 ? areas[0].geometry
      : { type: "GeometryCollection", geometries: areas.map((area) => area.geometry) };
    const areaSqKm = computeGeometryAreaSqKm(geometry);
    if (!(areaSqKm > 0)) {
      complete = false;
      continue;
    }
    const key = createHash("sha256").update(JSON.stringify([groupKey, areaIds])).digest("hex").slice(0, 24);
    const names = [...new Set(areas.map((area) => area.name).filter(Boolean))];
    const stationOrArea = names.length <= 3 ? names.join("; ") : `${names.slice(0, 3).join("; ")} and ${names.length - 3} more areas`;
    features.push({
      type: "Feature", geometry,
      properties: { ...group.properties, id: ID_PREFIX + key, areaSqKm, stationOrArea,
        sourceUrl: `${ENDPOINT}/${encodeURIComponent(areaIds[0])}?f=html` },
    });
  }
  if (complete) onSnapshot?.(ID_PREFIX, new Set(features.map((feature) => feature.properties.id)));
  console.log(`[ecccWeather] Parsed ${features.length} Canadian weather bulletins from ${rows.length} area records`);
  return features;
}
