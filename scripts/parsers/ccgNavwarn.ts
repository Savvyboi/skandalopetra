import type { FeatureCollection, Geometry, Position } from "geojson";
import type { HazardFeature } from "../../src/types/schema.ts";
import { computeDurationHours, computeGeometryAreaSqKm } from "../utils/geometry.ts";

const ENDPOINT = "https://e-nav.ccg-gcc.gc.ca/geoserver/nis/nw_en/ows?outputFormat=application%2Fjson&request=GetFeature&service=WFS&typeName=nw_en&version=2.0.0";
const BULLETINS = "https://nis.ccg-gcc.gc.ca/public/rest/messages/en/search";
const ID_PREFIX = "CCG-NAVWARN-";
const DAY = 86400;

interface NoticeProperties {
  nis_id?: string;
  publication_date?: string;
  valid_until?: string | null;
  validity?: string;
  subject?: string | null;
  title?: string | null;
  desc?: string | null;
  areas?: string | null;
  categories?: string | null;
  web_link?: string | null;
}

interface NoticeGroup {
  properties: NoticeProperties;
  points: Position[];
  lines: Position[][];
  polygons: Position[][][];
}

function validPosition(position: Position): boolean {
  return Array.isArray(position) && position.length >= 2 &&
    Number.isFinite(position[0]) && Math.abs(position[0]) <= 180 &&
    Number.isFinite(position[1]) && Math.abs(position[1]) <= 90;
}

function validLine(line: Position[]): boolean {
  return Array.isArray(line) && line.length >= 2 && line.every(validPosition);
}

function validPolygon(polygon: Position[][]): boolean {
  return Array.isArray(polygon) && polygon.length > 0 && polygon.every((ring) => {
    if (!validLine(ring) || ring.length < 4) return false;
    const end = ring[ring.length - 1];
    return ring[0][0] === end[0] && ring[0][1] === end[1];
  });
}

function addGeometry(group: NoticeGroup, geometry: Geometry | null): void {
  switch (geometry?.type) {
    case "Point":
      if (validPosition(geometry.coordinates)) group.points.push(geometry.coordinates);
      break;
    case "LineString":
      if (validLine(geometry.coordinates)) group.lines.push(geometry.coordinates);
      break;
    case "Polygon":
      if (validPolygon(geometry.coordinates)) group.polygons.push(geometry.coordinates);
      break;
    case "MultiPoint":
      if (Array.isArray(geometry.coordinates)) group.points.push(...geometry.coordinates.filter(validPosition));
      break;
    case "MultiLineString":
      if (Array.isArray(geometry.coordinates)) group.lines.push(...geometry.coordinates.filter(validLine));
      break;
    case "MultiPolygon":
      if (Array.isArray(geometry.coordinates)) group.polygons.push(...geometry.coordinates.filter(validPolygon));
      break;
  }
}

function combineGeometry(group: NoticeGroup): Geometry | undefined {
  const { points, lines, polygons } = group;
  const geometries: Geometry[] = [];
  if (points.length) geometries.push(points.length === 1
    ? { type: "Point", coordinates: points[0] }
    : { type: "MultiPoint", coordinates: points });
  if (lines.length) geometries.push(lines.length === 1
    ? { type: "LineString", coordinates: lines[0] }
    : { type: "MultiLineString", coordinates: lines });
  if (polygons.length) geometries.push(polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons });
  return geometries.length > 1 ? { type: "GeometryCollection", geometries } : geometries[0];
}

const ENTITIES: Record<string, string> = {
  amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
};

function plainText(html: string): string {
  return html
    .replace(/<\/?(?:p|div|li|tr)\b[^>]*>|<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|apos|gt|lt|nbsp|quot|#(?:x[0-9a-f]+|\d+));/gi, (entity, name: string) => {
      const key = name.toLowerCase();
      if (!key.startsWith("#")) return ENTITIES[key];
      const codePoint = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .split(/\s*\n\s*/)
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeNotice(id: string, group: NoticeGroup, nowSec: number): HazardFeature | null {
  const p = group.properties;
  const geometry = combineGeometry(group);
  const issuedAt = Math.floor(Date.parse(p.publication_date ?? "") / 1000);
  if (!geometry || !Number.isFinite(issuedAt) || p.title?.toLowerCase() === "inforce list") return null;

  let validTo: number;
  if (p.valid_until) {
    validTo = Math.floor(Date.parse(p.valid_until) / 1000);
  } else if (p.validity === "TWENTY_FOUR_HOURS") {
    validTo = issuedAt + DAY;
  } else if (p.validity === "UNTIL_CANCELLED") {
    validTo = Math.max(nowSec, issuedAt) + 7 * DAY;
  } else {
    return null;
  }
  if (!Number.isFinite(validTo) || validTo < issuedAt) return null;

  const subject = p.title || p.subject || p.categories || "Navigation warning";
  const navArea = /^NW-NAVAREA(XVIII?)-/.exec(p.nis_id ?? "")?.[1];
  const danger = /\b(?:DANGEROUS WRECK|DRIFTING HAZARD|EXCLUSION ZONE|HAZARDOUS AREA|SHALLOW DEPTH|SUBMERGED OBJECT|UNCHARTED ROCK|WATERWAY CLOSED)\b/i.test(
    `${subject} ${p.categories ?? ""}`,
  );
  const sourceUrl = p.web_link && /^https:\/\/nis\.ccg-gcc\.gc\.ca\/public\/rest\/messages\/en\/message\/\d+$/.test(p.web_link)
    ? p.web_link
    : BULLETINS;
  return {
    type: "Feature",
    geometry,
    properties: {
      id,
      domain: "maritime",
      subType: navArea ? "NAVAREA" : "NAVWARN",
      severity: danger ? "danger" : "warning",
      title: `${p.nis_id} · ${subject}`,
      rawText: plainText(p.desc ?? "") || subject,
      stationOrArea: navArea ?? (p.areas || "Canadian waters"),
      issuer: "Canadian Coast Guard",
      country: "Canada",
      region: "North America",
      areaSqKm: computeGeometryAreaSqKm(geometry),
      durationHours: computeDurationHours(issuedAt, validTo),
      issuedAt,
      validFrom: issuedAt,
      validTo,
      sourceUrl,
    },
  };
}

export async function fetchCcgNavwarnHazards(
  nowSec: number,
  onSnapshot?: (idPrefix: string, activeIds: ReadonlySet<string>) => void,
): Promise<HazardFeature[]> {
  const response = await fetch(ENDPOINT, {
    headers: { "User-Agent": "GlobalHazardTracker/1.0 (+https://github.com)", Accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`[ccgNavwarn] HTTP ${response.status}`);
  const collection = await response.json() as FeatureCollection<Geometry | null, NoticeProperties | null> & {
    numberMatched?: number;
    numberReturned?: number;
  };
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("[ccgNavwarn] Expected a GeoJSON FeatureCollection");
  }

  let complete = collection.numberMatched === collection.features.length &&
    collection.numberReturned === collection.features.length;
  const notices = new Map<string, NoticeGroup>();
  for (const item of collection.features) {
    const p = item?.properties;
    if (item?.type !== "Feature" || typeof p?.nis_id !== "string" || !/^NW-(?:[A-Z]|NAVAREAXVIII?)-\d+-\d{2}$/.test(p.nis_id)) {
      complete = false;
      continue;
    }
    const id = `${ID_PREFIX}${p.nis_id}`;
    let group = notices.get(id);
    if (!group) {
      group = { properties: p, points: [], lines: [], polygons: [] };
      notices.set(id, group);
    }
    addGeometry(group, item.geometry);
  }

  const features: HazardFeature[] = [];
  for (const [id, group] of notices) {
    const feature = normalizeNotice(id, group, nowSec);
    if (feature) features.push(feature);
  }
  if (complete) onSnapshot?.(ID_PREFIX, new Set(notices.keys()));
  else console.warn("[ccgNavwarn] Partial WFS response; keeping previously cached notices");
  console.log(`[ccgNavwarn] Parsed ${features.length} geolocated warnings from ${notices.size} notices`);
  return features;
}
