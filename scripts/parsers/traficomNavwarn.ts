import type { FeatureCollection, Geometry, Position } from "geojson";
import type { HazardFeature } from "../../src/types/schema.ts";
import { computeDurationHours, computeGeometryAreaSqKm } from "../utils/geometry.ts";

const WFS_URL = "https://julkinen.traficom.fi/inspirepalvelu/avoin/wfs";
const SOURCE_URL = "https://traficom.fi/fi/uutiset/merivaroitukset-saatavilla-traficomin-paikkatietopalvelusta-1312026-alkaen";
const ID_PREFIX = "TRAFICOM-NAVWARN-";
const LAYERS = ["navigational_warnings_a", "navigational_warnings_l", "navigational_warnings_p"];
const CACHE_WINDOW_SECONDS = 24 * 60 * 60;

interface WarningProperties {
  MESSAGESERIESIDENTIFIERINTEROPERABILITYIDENTIFIER?: string;
  MESSAGESERIESIDENTIFIERWARNINGNUMBER?: number;
  MESSAGESERIESIDENTIFIERYEAR?: number;
  PUBLICATIONTIME?: string;
  WARNINGINFORMATION_EN?: string | null;
  WARNINGINFORMATION_FI?: string | null;
  WARNINGINFORMATION_SV?: string | null;
  WARNINGINFORMATIONNAVWARNTYPEDETAILS_EN?: string | null;
  NAVWARNTYPEGENERAL_EN?: string | null;
  GENERALAREALOCATIONNAME_EN?: string | null;
  LOCALITYLOCATIONNAME_EN?: string | null;
}

interface WarningGroup {
  properties: WarningProperties;
  geometries: Geometry[];
}

function validPosition(position: unknown): position is Position {
  return Array.isArray(position) && position.length >= 2 &&
    Number.isFinite(position[0]) && Math.abs(position[0]) <= 180 &&
    Number.isFinite(position[1]) && Math.abs(position[1]) <= 90;
}

function validLine(line: unknown): line is Position[] {
  return Array.isArray(line) && line.length >= 2 && line.every(validPosition);
}

function validPolygon(polygon: unknown): boolean {
  return Array.isArray(polygon) && polygon.length > 0 && polygon.every((ring) => {
    if (!validLine(ring) || ring.length < 4) return false;
    const first = ring[0];
    const last = ring[ring.length - 1];
    return first[0] === last[0] && first[1] === last[1];
  });
}

function validGeometry(geometry: Geometry | null): geometry is Geometry {
  switch (geometry?.type) {
    case "Point": return validPosition(geometry.coordinates);
    case "LineString": return validLine(geometry.coordinates);
    case "Polygon": return validPolygon(geometry.coordinates);
    case "MultiPoint":
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 &&
        geometry.coordinates.every(validPosition);
    case "MultiLineString":
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 &&
        geometry.coordinates.every(validLine);
    case "MultiPolygon":
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 &&
        geometry.coordinates.every(validPolygon);
    default: return false;
  }
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeWarning(id: string, group: WarningGroup, nowSec: number): HazardFeature | null {
  const { properties, geometries } = group;
  const issuedAt = Math.floor(Date.parse(properties.PUBLICATIONTIME ?? "") / 1000);
  const rawText = firstText(properties.WARNINGINFORMATION_EN, properties.WARNINGINFORMATION_FI, properties.WARNINGINFORMATION_SV);
  if (geometries.length === 0 || !Number.isFinite(issuedAt) || !rawText) return null;

  const geometry: Geometry = geometries.length === 1
    ? geometries[0]
    : { type: "GeometryCollection", geometries };
  // The WFS snapshot has publication dates and does not provide warning expiry dates.
  const validTo = Math.max(issuedAt, nowSec) + CACHE_WINDOW_SECONDS;
  const warningNumber = properties.MESSAGESERIESIDENTIFIERWARNINGNUMBER;
  const year = properties.MESSAGESERIESIDENTIFIERYEAR;
  const reference = Number.isInteger(warningNumber) && Number.isInteger(year)
    ? ` ${warningNumber}/${year}` : "";
  const category = firstText(properties.WARNINGINFORMATIONNAVWARNTYPEDETAILS_EN, properties.NAVWARNTYPEGENERAL_EN);
  const locality = firstText(properties.LOCALITYLOCATIONNAME_EN, properties.GENERALAREALOCATIONNAME_EN, "Finnish waters");
  const danger = /\b(?:FIRING|GUNNERY|MISSILE|EXPLOSIVE|UNEXPLODED|DANGEROUS WRECK|MINEFIELD)\b/i.test(`${category} ${rawText}`);
  return {
    type: "Feature",
    geometry,
    properties: {
      id,
      domain: "maritime",
      subType: "NAVWARN",
      severity: danger ? "danger" : "warning",
      title: `Finland NAVWARN${reference}${category ? ` · ${category}` : ""}`,
      rawText,
      stationOrArea: locality,
      issuer: "Finnish Transport and Communications Agency Traficom",
      country: "Finland",
      region: "Europe",
      areaSqKm: computeGeometryAreaSqKm(geometry),
      durationHours: computeDurationHours(issuedAt, validTo),
      issuedAt,
      validFrom: issuedAt,
      validTo,
      validityNote: "Traficom does not publish an end time in this feed. The display window renews while the warning remains in the active feed.",
      sourceUrl: SOURCE_URL,
    },
  };
}

async function fetchLayer(layer: string) {
  const query = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: `avoin:${layer}`,
    outputFormat: "application/json",
    srsName: "EPSG:4326",
  });
  const response = await fetch(`${WFS_URL}?${query}`, {
    headers: { "User-Agent": "GlobalHazardTracker/1.0 (+https://github.com)", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`[traficomNavwarn] ${layer} HTTP ${response.status}`);
  const collection = await response.json() as FeatureCollection<Geometry | null, WarningProperties | null> & {
    numberMatched?: number;
    numberReturned?: number;
  };
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features) ||
    collection.numberMatched !== collection.features.length || collection.numberReturned !== collection.features.length) {
    throw new Error(`[traficomNavwarn] ${layer} did not return a complete WFS snapshot`);
  }
  return collection.features;
}

export async function fetchTraficomNavwarnHazards(
  nowSec: number,
  onSnapshot?: (idPrefix: string, activeIds: ReadonlySet<string>) => void,
): Promise<HazardFeature[]> {
  // A warning can have footprints in more than one layer. Keep the previous
  // snapshot if any layer is incomplete rather than overwriting half a warning.
  const layers = await Promise.all(LAYERS.map(fetchLayer));
  const warnings = new Map<string, WarningGroup>();
  for (const item of layers.flat()) {
    const p = item?.properties;
    const identifier = p?.MESSAGESERIESIDENTIFIERINTEROPERABILITYIDENTIFIER?.trim();
    if (item?.type !== "Feature" || !p || !identifier || !/^urn:mrn:fin:navwarn:[\w:-]+$/i.test(identifier)) {
      throw new Error("[traficomNavwarn] Missing or invalid warning identifier");
    }
    const id = ID_PREFIX + identifier.slice("urn:mrn:fin:navwarn:".length);
    let group = warnings.get(id);
    if (!group) {
      group = { properties: p, geometries: [] };
      warnings.set(id, group);
    }
    if (validGeometry(item.geometry)) group.geometries.push(item.geometry);
  }

  const features: HazardFeature[] = [];
  for (const [id, group] of warnings) {
    const feature = normalizeWarning(id, group, nowSec);
    if (feature) features.push(feature);
  }
  onSnapshot?.(ID_PREFIX, new Set(warnings.keys()));
  console.log(`[traficomNavwarn] Parsed ${features.length} geolocated warnings from ${warnings.size} notices`);
  return features;
}
