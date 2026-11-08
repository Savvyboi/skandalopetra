import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type { HazardFeature } from "../../src/types/schema.ts";
import {
  computeDurationHours,
  computeGeometryAreaSqKm,
  parseNgaCancelTimestamp,
  parseNgaCoordinates,
} from "../utils/geometry.ts";

const API_BASE = "https://api.kystverket.no/data/navigationwarnings";
const REPORT_BASE = "https://kyvreports.kystverket.no/NavcoReport";
const FEEDS = [
  {
    path: "coastal",
    idPrefix: "KYSTVERKET-NAVWARN-",
    subType: "NAVWARN",
    title: "Norway coastal warning",
    area: "Norwegian coast",
    report: "navigasjonsvarsler.aspx",
  },
  {
    path: "navareaxix",
    idPrefix: "KYSTVERKET-NAVAREA-XIX-",
    subType: "NAVAREA",
    title: "NAVAREA XIX warning",
    area: "XIX",
    report: "navareaxixvarsler.aspx",
  },
] as const;

interface WarningProperties {
  status?: string;
  eventid?: number;
  warningnumber?: string;
  location?: string | null;
  dtg_timestamp?: string;
  timestamp?: string;
  message_en?: string | null;
  message_no?: string | null;
  warning_en?: string | null;
  warning_no?: string | null;
}

type WarningFeed = (typeof FEEDS)[number];
type SnapshotCallback = (idPrefix: string, activeIds: ReadonlySet<string>) => void;

function validPosition(position: Position): boolean {
  return Array.isArray(position) && position.length >= 2 &&
    Number.isFinite(position[0]) && Math.abs(position[0]) <= 180 &&
    Number.isFinite(position[1]) && Math.abs(position[1]) <= 90;
}

function validGeometry(geometry: Geometry | null | undefined): geometry is Geometry {
  if (!geometry) return false;
  switch (geometry.type) {
    case "Point":
      return validPosition(geometry.coordinates);
    case "MultiPoint":
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 &&
        geometry.coordinates.every(validPosition);
    case "Polygon":
      return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 &&
        geometry.coordinates.every((ring) => Array.isArray(ring) && ring.length >= 4 &&
          ring.every(validPosition) && ring[0][0] === ring.at(-1)?.[0] &&
          ring[0][1] === ring.at(-1)?.[1]);
    default:
      return false;
  }
}

function normalizeWarning(
  item: Feature<Geometry | null, WarningProperties | null>,
  feed: WarningFeed,
  id: string,
  nowSec: number,
): HazardFeature | null {
  const p = item.properties;
  const text = (p?.message_en || p?.warning_en || p?.message_no || p?.warning_no)?.trim();
  const timestamp = p?.dtg_timestamp ?? p?.timestamp;
  if (!text || !timestamp) return null;

  // Kystverket's timezone-less DTG timestamps are UTC, as on its bulletin pages.
  const utc = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ? timestamp : `${timestamp}Z`;
  const issuedAt = Math.floor(Date.parse(utc) / 1000);
  if (!Number.isFinite(issuedAt)) return null;

  const rawText = text.replace(/&nbsp;/gi, " ");
  if (/\b(?:LIST OF CURRENT NAVAREA XIX WARNINGS|NAVAREA XIX WARNINGS IN\s*FORCE AT)\b/i.test(rawText)) {
    return null;
  }

  let geometry = item.geometry;
  let geometryNote = "Kystverket supplies the footprint, which may be an approximate position or a general warning area.";
  if (!validGeometry(geometry)) {
    const positions = parseNgaCoordinates(rawText);
    if (positions.length === 0) return null;
    geometry = positions.length === 1
      ? { type: "Point", coordinates: positions[0] }
      : { type: "MultiPoint", coordinates: positions };
    geometryNote = "Locations extracted from bulletin text. The published warning defines their scope.";
  }

  const cancellation = parseNgaCancelTimestamp(rawText, issuedAt);
  if (cancellation === null && /\bCANCEL\s+THIS\s+(?:MSG|MESSAGE)\b/i.test(rawText)) return null;
  const validTo = cancellation === null
    ? Math.max(nowSec, issuedAt) + 7 * 86400
    : Math.max(issuedAt, cancellation);
  const severity = /\b(?:GUNNERY|FIRING|MISSILE|ROCKET|MINE|UNEXPLODED|TSUNAMI|PIRACY)\b/i.test(rawText)
    ? "danger"
    : "warning";

  return {
    type: "Feature",
    geometry,
    properties: {
      id,
      domain: "maritime",
      subType: feed.subType,
      severity,
      title: `${feed.title} ${p?.warningnumber ?? p?.eventid}`,
      rawText,
      stationOrArea: p?.location?.trim() || feed.area,
      issuer: "Norwegian Coastal Administration (Kystverket)",
      country: "Norway",
      region: "Europe",
      areaSqKm: computeGeometryAreaSqKm(geometry),
      durationHours: computeDurationHours(issuedAt, validTo),
      issuedAt,
      validFrom: issuedAt,
      validTo,
      sourceUrl: `${REPORT_BASE}/${feed.report}`,
      geometryNote,
    },
  };
}

async function fetchWarnings(
  nowSec: number,
  feed: WarningFeed,
  onSnapshot?: SnapshotCallback,
): Promise<HazardFeature[]> {
  const response = await fetch(`${API_BASE}/${feed.path}/`, {
    headers: {
      "User-Agent": "GlobalHazardTracker/1.0 (+https://github.com)",
      Accept: "application/geojson",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const collection = await response.json() as FeatureCollection<Geometry | null, WarningProperties | null>;
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("Expected a GeoJSON FeatureCollection");
  }

  const features: HazardFeature[] = [];
  const activeIds = new Set<string>();
  let complete = true;
  for (const item of collection.features) {
    const { eventid, status } = item?.properties ?? {};
    if (item?.type !== "Feature" || !Number.isSafeInteger(eventid) || typeof status !== "string") {
      complete = false;
      continue;
    }
    if (status.toLowerCase() !== "active") {
      // The active feed only documents active records. Preserve the cache if its status format changes.
      complete = false;
      continue;
    }

    const id = `${feed.idPrefix}${eventid}`;
    activeIds.add(id);
    const feature = normalizeWarning(item, feed, id, nowSec);
    if (feature) features.push(feature);
  }
  if (complete) onSnapshot?.(feed.idPrefix, activeIds);
  console.log(`[kystverket] Parsed ${features.length} ${feed.path} warnings from ${collection.features.length} records`);
  return features;
}

export async function fetchKystverketHazards(
  nowSec: number,
  onSnapshot?: SnapshotCallback,
): Promise<HazardFeature[]> {
  const results = await Promise.allSettled(FEEDS.map((feed) => fetchWarnings(nowSec, feed, onSnapshot)));
  return results.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    console.warn(`[kystverket] ${FEEDS[index].path} unavailable:`, result.reason);
    return [];
  });
}
