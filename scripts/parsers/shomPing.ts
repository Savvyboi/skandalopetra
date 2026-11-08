import type { Geometry, Position } from "geojson";
import type { HazardFeature, HazardRegion } from "../../src/types/schema.ts";
import { closePolygonRings, computeDurationHours, computeGeometryAreaSqKm } from "../utils/geometry.ts";

const API = "https://services.ping-info-nautique.fr/api/warnings";
const ID_PREFIX = "SHOM-PING-";
const SERIES = ["NAVAREA", "COASTAL", "LOCAL", "SUB_AREA"].map((name) => `${name}_NAVIGATIONAL_WARNING`);
const PAGE_SIZE = 500;
const MAX_PAGES = 8;
const MAX_SEPARATE_DETAILS = 24;
const DAY = 86_400;
const MERCATOR_RADIUS = 6_378_137;
const MERCATOR_LIMIT = Math.PI * MERCATOR_RADIUS;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

interface PingFootprints {
  geometries?: { geometry?: Geometry }[];
  affectedAreas?: { geometry?: Geometry }[];
}

interface PingRange {
  dateStart?: string;
  dateEnd?: string;
  timeOfDayStart?: string;
  timeOfDayEnd?: string;
  timezone?: string;
}

interface PingPart extends PingFootprints {
  information?: Record<string, string>;
  dateRanges?: PingRange[];
}

interface PingRecord {
  id?: string;
  nameOfSeries?: string;
  warningNumber?: number;
  year?: number;
  publicationTime?: string;
}

interface PingDetails extends PingRecord {
  status?: string;
  cancellationDate?: string;
  warningHazardTypeGeneral?: string;
  generalAreas?: Record<string, string[]>;
  localities?: Record<string, string[]>;
  featureParts?: PingPart[];
}

interface PingMap extends PingRecord, PingFootprints {
  warningTypeDetails?: string;
}

interface PingPage {
  _embedded?: { items?: PingDetails[] };
  page?: { number: number; size: number; totalPages: number; totalElements: number };
}

interface WarningWindow {
  key: string;
  from: number;
  to: number;
  note?: string;
}

interface GeometryGroup {
  parts: PingPart[];
  footprints: PingFootprints;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const result = Math.floor(Date.parse(value) / 1000);
  return Number.isFinite(result) ? result : undefined;
}

function dateWithOffset(date: unknown, time: unknown, timezone: unknown, end: boolean): number | undefined {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) return undefined;
  const offset = typeof timezone === "string" && /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/i.exec(timezone);
  if (!offset) return undefined;
  const offsetHours = Number(offset[2] ?? 0);
  const offsetMinutes = Number(offset[3] ?? 0);
  if (offsetHours > 14 || offsetMinutes >= 60 || (offsetHours === 14 && offsetMinutes > 0)) return undefined;
  const secondsEast = (offset[1] === "-" ? -1 : 1) * (offsetHours * 3600 + offsetMinutes * 60);
  if (time === undefined) return midnight / 1000 + (end ? DAY - 1 : 0) - secondsEast;
  const clock = typeof time === "string" && /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!clock) return undefined;
  const [hour, minute, second] = [Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)];
  if (hour >= 24 || minute >= 60 || second >= 60) return undefined;
  return midnight / 1000 + hour * 3600 + minute * 60 + second - secondsEast;
}

function warningWindow(
  range: PingRange | undefined, issuedAt: number, cancellation: number | undefined, nowSec: number,
): WarningWindow | null {
  if (range && !range.dateStart && !range.dateEnd) return null;
  const start = range?.dateStart === undefined
    ? issuedAt : dateWithOffset(range.dateStart, range.timeOfDayStart, range.timezone, false);
  const end = range?.dateEnd === undefined
    ? undefined : dateWithOffset(range.dateEnd, range.timeOfDayEnd, range.timezone, true);
  if (start === undefined || (range?.dateEnd !== undefined && end === undefined) ||
      (end !== undefined && end < start)) return null;

  const from = Math.max(start, issuedAt);
  const publishedEnd = Math.min(end ?? Infinity, cancellation ?? Infinity);
  const to = Number.isFinite(publishedEnd) ? publishedEnd : Math.max(nowSec, from) + DAY;
  const notes = [];
  if (range?.dateStart && range.dateEnd && range.dateStart !== range.dateEnd &&
      ((range.timeOfDayStart && !/^00:00(?::00)?$/.test(range.timeOfDayStart)) ||
        (range.timeOfDayEnd && !/^23:59(?::(?:00|59))?$/.test(range.timeOfDayEnd)))) {
    notes.push("The map shows the published multi-day window. Check the bulletin for daily operating hours.");
  }
  if (!Number.isFinite(publishedEnd)) {
    notes.push("PING supplied no end time. The display window renews while the warning remains published.");
  }
  return { key: `${start}-${end ?? "open"}`, from, to, note: notes.join(" ") || undefined };
}

function projectPosition(value: unknown): Position | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const [x, y] = value;
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MERCATOR_LIMIT + 1 || Math.abs(y) > MERCATOR_LIMIT + 1) return undefined;
  const lon = Math.max(-180, Math.min(180, (x / MERCATOR_LIMIT) * 180));
  const lat = Math.atan(Math.sinh(y / MERCATOR_RADIUS)) * (180 / Math.PI);
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
}

function convertArray<T>(value: unknown, convert: (entry: unknown) => T | undefined, minimum = 1): T[] | undefined {
  if (!Array.isArray(value) || value.length < minimum) return undefined;
  const values: T[] = [];
  for (const entry of value) {
    const converted = convert(entry);
    if (converted === undefined) return undefined;
    values.push(converted);
  }
  return values;
}

const projectLine = (value: unknown) => convertArray(value, projectPosition, 2);
const projectRing = (value: unknown) => {
  const ring = convertArray(value, projectPosition, 3);
  return ring && new Set(ring.map((point) => point.join(","))).size >= 3 ? ring : undefined;
};
const projectPolygon = (value: unknown) => convertArray(value, projectRing);

function projectGeometry(geometry: Geometry | undefined): Geometry | undefined {
  switch (geometry?.type) {
    case "Point": {
      const coordinates = projectPosition(geometry.coordinates);
      return coordinates ? { type: "Point", coordinates } : undefined;
    }
    case "MultiPoint": {
      const coordinates = convertArray(geometry.coordinates, projectPosition);
      return coordinates ? { type: "MultiPoint", coordinates } : undefined;
    }
    case "LineString": {
      const coordinates = projectLine(geometry.coordinates);
      return coordinates ? { type: "LineString", coordinates } : undefined;
    }
    case "MultiLineString": {
      const coordinates = convertArray(geometry.coordinates, projectLine);
      return coordinates ? { type: "MultiLineString", coordinates } : undefined;
    }
    case "Polygon": {
      const coordinates = projectPolygon(geometry.coordinates);
      return coordinates ? closePolygonRings({ type: "Polygon", coordinates }) : undefined;
    }
    case "MultiPolygon": {
      const coordinates = convertArray(geometry.coordinates, projectPolygon);
      return coordinates ? closePolygonRings({ type: "MultiPolygon", coordinates }) : undefined;
    }
    default: return undefined;
  }
}

function geography(series: string): { country: string; region: HazardRegion } {
  if (/^NAVAREA II$/i.test(series)) return { country: "East Atlantic", region: "High Seas" };
  if (/CAYENNE/i.test(series)) return { country: "French Guiana", region: "South America" };
  if (/FORT DE FRANCE/i.test(series)) return { country: "French Caribbean", region: "North America" };
  if (/REUNION/i.test(series)) return { country: "Réunion", region: "Africa" };
  return { country: "France", region: "Europe" };
}

function geographicNames(names?: Record<string, string[]>): string[] {
  const result = names?.en ?? names?.fr;
  return Array.isArray(result) ? result.filter((name) => typeof name === "string" && name.trim()) : [];
}

function renderGroups(
  map: PingMap, detail: PingDetails, groups: GeometryGroup[], nowSec: number,
): { features: HazardFeature[]; complete: boolean } {
  const issuedAt = timestamp(detail.publicationTime);
  const series = detail.nameOfSeries;
  const id = detail.id;
  const cancellation = timestamp(detail.cancellationDate);
  if (!id || !series || issuedAt === undefined || !Number.isInteger(detail.warningNumber) || !Number.isInteger(detail.year) ||
      (detail.cancellationDate != null && cancellation === undefined)) return { features: [], complete: false };
  if (["IN_FORCE_BULLETIN", "RIG_LIST"].includes(detail.warningHazardTypeGeneral ?? "")) return { features: [], complete: true };

  const windows = new Map<string, { window: WarningWindow; shapes: Map<string, Geometry>; texts: Set<string>; approximate: boolean }>();
  let complete = true;
  for (const { parts, footprints } of groups) {
    if (!Array.isArray(footprints.geometries) || !Array.isArray(footprints.affectedAreas) ||
        !Array.isArray(parts[0]?.dateRanges)) {
      complete = false;
      continue;
    }
    const approximate = footprints.geometries.length === 0;
    const sourceShapes = approximate ? footprints.affectedAreas : footprints.geometries;
    if (sourceShapes.length === 0) continue;
    const shapes = sourceShapes.map((feature) => projectGeometry(feature?.geometry));
    if (shapes.some((shape) => !shape)) {
      complete = false;
      continue;
    }
    const ranges = parts[0].dateRanges.length ? parts[0].dateRanges : [undefined];
    for (const range of ranges) {
      const window = warningWindow(range, issuedAt, cancellation, nowSec);
      if (!window) {
        complete = false;
        continue;
      }
      if (window.to < window.from || window.to < nowSec - 7 * DAY) continue;
      let group = windows.get(window.key);
      if (!group) {
        group = { window, shapes: new Map(), texts: new Set(), approximate };
        windows.set(window.key, group);
      }
      group.approximate ||= approximate;
      for (const shape of shapes) {
        if (shape) group.shapes.set(JSON.stringify(shape), shape);
      }
      for (const part of parts) {
        const text = part.information?.en?.trim() || part.information?.fr?.trim();
        if (text) group.texts.add(text);
      }
    }
  }

  const navarea = /^NAVAREA II$/i.test(series);
  const category = map.warningTypeDetails?.trim().replaceAll("_", " ") ?? "";
  const label = `${series} ${detail.warningNumber}/${detail.year}`;
  const place = [...new Set([...geographicNames(detail.generalAreas), ...geographicNames(detail.localities)])].join(" · ");
  const severity = /\b(?:FIRING|EXPLOSIVE|WRECK|TSUNAMI|PIRACY|MINEFIELD|BLASTING|ROCKET)\b/i.test(category) ? "danger" : "warning";
  const features: HazardFeature[] = [];
  for (const { window, shapes, texts, approximate } of windows.values()) {
    const geometries = [...shapes.values()];
    const geometry: Geometry = geometries.length === 1 ? geometries[0] : { type: "GeometryCollection", geometries };
    features.push({
      type: "Feature",
      geometry,
      properties: {
        id: `${ID_PREFIX}${id}-${window.key}`,
        domain: "maritime",
        subType: navarea ? "NAVAREA" : "NAVWARN",
        severity,
        title: category ? `${label} · ${category}` : label,
        rawText: [...texts].join("\n\n") || label,
        stationOrArea: place || series,
        issuer: "SHOM PING",
        ...geography(series),
        areaSqKm: computeGeometryAreaSqKm(geometry),
        durationHours: computeDurationHours(window.from, window.to),
        issuedAt,
        validFrom: window.from,
        validTo: window.to,
        sourceUrl: `${API}/${id}`,
        ...(window.note ? { validityNote: window.note } : {}),
        ...(approximate ? { geometryNote: "PING supplied an affected area as the location of this warning." } : {}),
      },
    });
  }
  return { features, complete };
}

function warningQuery(): URLSearchParams {
  const query = new URLSearchParams();
  for (const serie of SERIES) query.append("serieType", serie);
  return query;
}

async function pingJson(path: string): Promise<unknown> {
  const response = await fetch(`${API}/${path}`, {
    headers: { "User-Agent": "Skandalopetra/1.0 (+https://github.com/Savvyboi/skandalopetra)", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`[shomPing] PING HTTP ${response.status} for ${path.split("?")[0]}`);
  return response.json();
}

async function detailsPage(number: number) {
  const query = warningQuery();
  query.set("size", String(PAGE_SIZE));
  query.set("page", String(number));
  const data = await pingJson(`detailed-table?${query}`) as PingPage;
  const page = data?.page;
  if (!page || page.number !== number || !Number.isInteger(page.size) || page.size <= 0 ||
      !Number.isInteger(page.totalElements) || page.totalElements < 0 ||
      page.totalPages !== Math.ceil(page.totalElements / page.size) || page.totalPages > MAX_PAGES) {
    throw new Error("[shomPing] Invalid or oversized PING pagination response");
  }
  const rows = data._embedded?.items ?? [];
  const expected = Math.min(page.size, page.totalElements - number * page.size);
  if (!Array.isArray(rows) || rows.length !== expected) throw new Error("[shomPing] Incomplete PING detail page");
  return { page, rows };
}

export async function fetchShomPingHazards(
  nowSec: number,
  onSnapshot?: (idPrefix: string, activeIds: ReadonlySet<string>) => void,
): Promise<HazardFeature[]> {
  const [first, maps] = await Promise.all([detailsPage(0), pingJson(`map?${warningQuery()}`)]);
  if (!Array.isArray(maps)) throw new Error("[shomPing] Invalid PING map response");
  const pages = await Promise.all(Array.from({ length: Math.max(0, first.page.totalPages - 1) }, (_, i) => detailsPage(i + 1)));
  if (pages.some(({ page }) => page.totalElements !== first.page.totalElements || page.size !== first.page.size)) {
    throw new Error("[shomPing] PING warnings changed during pagination");
  }

  const mapById = new Map<string, PingMap>();
  for (const map of maps as PingMap[]) {
    if (typeof map?.id !== "string" || !UUID.test(map.id) || mapById.has(map.id)) {
      throw new Error("[shomPing] Invalid or duplicate PING map warning ID");
    }
    mapById.set(map.id, map);
  }
  const details = [first, ...pages].flatMap(({ rows }) => rows);
  let complete = details.length === mapById.size;
  const seen = new Set<string>();
  const features: HazardFeature[] = [];
  const separate: { map: PingMap; detail: PingDetails }[] = [];

  for (const detail of details) {
    if (typeof detail?.id !== "string" || !UUID.test(detail.id) || seen.has(detail.id)) {
      throw new Error("[shomPing] Invalid or duplicate PING detail warning ID");
    }
    seen.add(detail.id);
    if (detail.status === "CANCELLED") continue;
    const map = mapById.get(detail.id);
    if (detail.status !== "PUBLISHED" || !map || map.nameOfSeries !== detail.nameOfSeries ||
        map.publicationTime !== detail.publicationTime ||
        !Array.isArray(detail.featureParts) || detail.featureParts.some((part) => !Array.isArray(part?.dateRanges))) {
      complete = false;
      continue;
    }
    if (!detail.featureParts.length) continue;
    const schedules = new Set(detail.featureParts.map((part) => JSON.stringify(part.dateRanges)));
    const mixedFootprints = detail.featureParts.length > 1 && map.geometries?.length && map.affectedAreas?.length;
    if (schedules.size > 1 || mixedFootprints) {
      separate.push({ map, detail });
      continue;
    }
    const result = renderGroups(map, detail, [{ parts: detail.featureParts, footprints: map }], nowSec);
    features.push(...result.features);
    complete &&= result.complete;
  }

  // Bulk details omit footprints on feature parts. Fetch individually when schedules
  // or affected-area fallbacks require the original association with each part.
  if (separate.length > MAX_SEPARATE_DETAILS) complete = false;
  for (let start = 0; start < Math.min(separate.length, MAX_SEPARATE_DETAILS); start += 6) {
    const results = await Promise.allSettled(separate.slice(start, start + 6).map(async ({ map, detail }) => {
      const entry = await pingJson(detail.id!) as PingDetails;
      if (entry?.id !== detail.id || entry.status !== "PUBLISHED" || entry.publicationTime !== detail.publicationTime ||
          !Array.isArray(entry.featureParts) || entry.featureParts.length !== detail.featureParts?.length) {
        return { features: [], complete: false };
      }
      return renderGroups(map, entry, entry.featureParts.map((part) => ({ parts: [part], footprints: part })), nowSec);
    }));
    for (const result of results) {
      if (result.status === "fulfilled") {
        features.push(...result.value.features);
        complete &&= result.value.complete;
      } else complete = false;
    }
  }

  if (complete) onSnapshot?.(ID_PREFIX, new Set(features.map(({ properties }) => properties.id)));
  else console.warn("[shomPing] Incomplete or inconsistent PING snapshot; retaining previously mapped warnings");
  console.log(`[shomPing] Parsed ${features.length} warning intervals from ${details.length} published PING notices`);
  return features;
}
