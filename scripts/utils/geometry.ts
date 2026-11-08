import circle from "@turf/circle";
import type { Geometry, Position } from "geojson";

const EARTH_RADIUS_KM = 6371.0088;

/** Closes source polygon rings while preserving the original geometry when already closed. */
export function closePolygonRings(geometry: Geometry): Geometry {
  let changed = false;
  const close = (rings: Position[][]) => rings.map((ring) => {
    const first = ring[0];
    const last = ring.at(-1);
    if (!first || !last || (first[0] === last[0] && first[1] === last[1])) return ring;
    changed = true;
    return [...ring, first];
  });
  if (geometry.type === "Polygon") {
    const coordinates = close(geometry.coordinates);
    return changed ? { ...geometry, coordinates } : geometry;
  }
  if (geometry.type === "MultiPolygon") {
    const coordinates = geometry.coordinates.map(close);
    return changed ? { ...geometry, coordinates } : geometry;
  }
  return geometry;
}

/**
 * Extracts Degrees-Decimal-Minutes or Degrees-Minutes-Seconds coordinates from NGA / UKHO / JCG / HNHS text.
 * Supports:
 *  - NGA / UKHO DDM: 58-12.5N 019-30.0E, 12-34.56S 123-45.67W
 *  - JCG DMS:        24-28-29N 132-46-04E
 *  - HNHS spaced/Greek DDM: 37 48.34N - 023 46.62E, 38-01.71B 022-51.00A (Greek Β=N, Α=E, Ν=S)
 */
export function parseNgaCoordinates(rawText: string): [number, number][] {
  const matches: Array<{ index: number; point: [number, number] }> = [];

  // 1. DMS with hyphens: 24-28-29N 132-46-04E
  const dmsHyphenRegex =
    /\b(\d{1,2})-(\d{2})-(\d{2}(?:\.\d+)?)\s*([NS])\s*(?:[-,]\s*)?(\d{1,3})-(\d{2})-(\d{2}(?:\.\d+)?)\s*([EW])\b/gi;
  let m: RegExpExecArray | null;
  while ((m = dmsHyphenRegex.exec(rawText)) !== null) {
    if ([m[2], m[3], m[6], m[7]].some((part) => Number(part) >= 60)) continue;
    let lat =
      parseInt(m[1], 10) +
      parseInt(m[2], 10) / 60 +
      parseFloat(m[3]) / 3600;
    if (m[4].toUpperCase() === "S") lat = -lat;
    let lon =
      parseInt(m[5], 10) +
      parseInt(m[6], 10) / 60 +
      parseFloat(m[7]) / 3600;
    if (m[8].toUpperCase() === "W") lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      matches.push({ index: m.index, point: [Number(lon.toFixed(5)), Number(lat.toFixed(5))] });
    }
  }

  // 2. DDM with hyphens or spaces (including Greek Β/B=N, Α/A=E):
  //    58-12.5N 019-30.0E | 37 48.34N - 023 46.62E | 38-01.71B 022-51.00A
  const ddmRegex =
    /(?<![\p{L}\d-])(\d{1,2})[-\s](\d{2}(?:[.,]\d+)?)\s*([NSB\u0392\u039d])\s*(?:[-,]\s*)?(\d{1,3})[-\s](\d{2}(?:[.,]\d+)?)\s*([EWA\u0391])(?=$|[^\p{L}\d])/giu;
  while ((m = ddmRegex.exec(rawText)) !== null) {
    const latDeg = parseInt(m[1], 10);
    const latMin = parseFloat(m[2].replace(",", "."));
    const latHem = m[3].toUpperCase();
    const lonDeg = parseInt(m[4], 10);
    const lonMin = parseFloat(m[5].replace(",", "."));
    const lonHem = m[6].toUpperCase();

    if (latMin >= 60 || lonMin >= 60) continue;

    let lat = latDeg + latMin / 60;
    let lon = lonDeg + lonMin / 60;
    if (latHem === "S" || latHem === "\u039d") lat = -lat;
    if (lonHem === "W") lon = -lon;

    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      matches.push({ index: m.index, point: [Number(lon.toFixed(5)), Number(lat.toFixed(5))] });
    }
  }

  return matches.sort((a, b) => a.index - b.index).map((match) => match.point);
}

/**
 * Extracts ICAO NOTAM E-section polygon/point coordinates such as:
 *  - 381500N 0241000E or 381500N0241000E (DDMMSS)
 *  - 3815.5N 02410.2E or 3815N 02410E (DDMM)
 */
export function parseIcaoNotamBodyCoords(bodyText: string): [number, number][] {
  const coords: [number, number][] = [];
  const regex =
    /\b(\d{2})(\d{2}(?:\.\d+)?)(\d{2}(?:\.\d+)?)?([NS])\s*(?:[-,]\s*)?(\d{3})(\d{2}(?:\.\d+)?)(\d{2}(?:\.\d+)?)?([EW])\b/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(bodyText)) !== null) {
    const latDeg = parseInt(m[1], 10);
    const latMin = Number(m[2]);
    const latSec = m[3] ? parseFloat(m[3]) : 0;
    const latHem = m[4].toUpperCase();

    const lonDeg = parseInt(m[5], 10);
    const lonMin = Number(m[6]);
    const lonSec = m[7] ? parseFloat(m[7]) : 0;
    const lonHem = m[8].toUpperCase();

    if (latDeg > 90 || latMin >= 60 || latSec >= 60) continue;
    if (lonDeg > 180 || lonMin >= 60 || lonSec >= 60) continue;

    let lat = latDeg + latMin / 60 + latSec / 3600;
    let lon = lonDeg + lonMin / 60 + lonSec / 3600;
    if (latHem === "S") lat = -lat;
    if (lonHem === "W") lon = -lon;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

    const pt: [number, number] = [Number(lon.toFixed(5)), Number(lat.toFixed(5))];
    const prev = coords[coords.length - 1];
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) {
      coords.push(pt);
    }
  }
  return coords;
}

function unwrapAntimeridian(coords: [number, number][]): [number, number][] {
  if (coords.length <= 1) return coords;
  const out: [number, number][] = [[coords[0][0], coords[0][1]]];
  for (let i = 1; i < coords.length; i++) {
    let lon = coords[i][0];
    const prevLon = out[i - 1][0];
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    out.push([Number(lon.toFixed(5)), coords[i][1]]);
  }
  return out;
}

/**
 * Converts extracted coordinate pairs into Point, LineString, or closed Polygon.
 * Automatically unwraps antimeridian jumps so Pacific polygons render cleanly in WebMercator.
 */
export function coordsToGeoJsonGeometry(
  coords: [number, number][]
): Geometry | null {
  const distinct = new Map(coords.map((point) => [point.join(","), point]));
  if (distinct.size === 0) return null;
  if (distinct.size === 1) {
    return { type: "Point", coordinates: coords[0] };
  }
  if (distinct.size === 2) {
    return { type: "LineString", coordinates: unwrapAntimeridian([...distinct.values()]) };
  }

  const ring = unwrapAntimeridian(coords);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }
  return { type: "Polygon", coordinates: [ring] };
}

/**
 * Parses an ICAO NOTAM Q-line coordinate/radius token (e.g., "5128N00027W005")
 * into a 32-vertex GeoJSON Polygon (radius in Nautical Miles) or Point for FIR-wide notices.
 */
export function parseNotamQLineCircle(
  qCoordToken: string,
  maxCircleRadiusNm = 150
): Geometry | null {
  const match = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3})$/.exec(
    qCoordToken.trim()
  );
  if (!match) return null;
  if (Number(match[2]) >= 60 || Number(match[5]) >= 60) return null;

  let lat = parseInt(match[1], 10) + parseInt(match[2], 10) / 60;
  if (match[3] === "S") lat = -lat;

  let lon = parseInt(match[4], 10) + parseInt(match[5], 10) / 60;
  if (match[6] === "W") lon = -lon;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const radiusNm = parseInt(match[7], 10);
  if (radiusNm <= 0 || radiusNm > maxCircleRadiusNm) {
    return {
      type: "Point",
      coordinates: [Number(lon.toFixed(5)), Number(lat.toFixed(5))],
    };
  }

  return createNmCircleGeometry(lon, lat, radiusNm);
}

/**
 * Extracts "CANCEL THIS MSG DDHHMMZ MON [YY]" into a Unix timestamp in seconds.
 */
export function parseNgaCancelTimestamp(
  rawText: string,
  issuedAt = Math.floor(Date.now() / 1000)
): number | null {
  const match =
    /CANCEL\s+THIS\s+(?:MSG|MESSAGE)\s+(\d{2})(\d{2})(\d{2})\s*(?:Z|UTC)\s+([A-Z]{3})\b(?:\s+(\d{4}|\d{2})\b)?/i.exec(
      rawText
    );
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const hour = parseInt(match[2], 10);
  const minute = parseInt(match[3], 10);
  const monthStr = match[4].toUpperCase();
  const yrRaw = match[5] ? Number(match[5]) : new Date(issuedAt * 1000).getUTCFullYear();
  const year = yrRaw < 100 ? 2000 + yrRaw : yrRaw;

  const months: Record<string, number> = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11,
  };
  const month = months[monthStr];
  if (month === undefined || day < 1 || hour > 23 || minute > 59) return null;

  const date = new Date(Date.UTC(year, month, day, hour, minute));
  if (date.getUTCDate() !== day) return null;
  if (!match[5] && date.getTime() / 1000 < issuedAt - 180 * 86400) {
    date.setUTCFullYear(year + 1);
  }
  return Math.floor(date.getTime() / 1000);
}

/**
 * Generates a 32-vertex circle polygon around [lon, lat] with radius in Nautical Miles.
 */
export function createNmCircleGeometry(
  lon: number,
  lat: number,
  radiusNm: number
): Geometry {
  if (!Number.isFinite(radiusNm) || radiusNm <= 0 || radiusNm >= 999) {
    return {
      type: "Point",
      coordinates: [Number(lon.toFixed(5)), Number(lat.toFixed(5))],
    };
  }
  const radiusKm = radiusNm * 1.852;
  const geometry = circle([lon, lat], radiusKm, { steps: 32, units: "kilometers" }).geometry;
  return {
    type: "Polygon",
    coordinates: geometry.coordinates.map((ring) =>
      ring.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))])
    ),
  };
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineKm(a: Position, b: Position): number {
  const dLat = toRad((b[1] ?? 0) - (a[1] ?? 0));
  const dLon = toRad((b[0] ?? 0) - (a[0] ?? 0));
  const lat1 = toRad(a[1] ?? 0);
  const lat2 = toRad(b[1] ?? 0);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function ringSphericalAreaSqKm(ring: Position[]): number {
  if (ring.length < 4) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    let dLonDeg = (p2[0] ?? 0) - (p1[0] ?? 0);
    while (dLonDeg > 180) dLonDeg -= 360;
    while (dLonDeg < -180) dLonDeg += 360;
    sum +=
      toRad(dLonDeg) *
      (2 + Math.sin(toRad(p1[1] ?? 0)) + Math.sin(toRad(p2[1] ?? 0)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/**
 * Computes approximate footprint area in km² for any GeoJSON geometry.
 * Returns 0 for Point/MultiPoint, corridor width (~2 km) * length for LineString,
 * and spherical surface area in km² for Polygon/MultiPolygon.
 */
export function computeGeometryAreaSqKm(geometry: Geometry | null | undefined): number {
  if (!geometry) return 0;

  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return 0;
    case "LineString": {
      let lenKm = 0;
      for (let i = 0; i < geometry.coordinates.length - 1; i++) {
        lenKm += haversineKm(geometry.coordinates[i], geometry.coordinates[i + 1]);
      }
      return Math.round(lenKm * 2 * 10) / 10;
    }
    case "MultiLineString": {
      let lenKm = 0;
      for (const line of geometry.coordinates) {
        for (let i = 0; i < line.length - 1; i++) {
          lenKm += haversineKm(line[i], line[i + 1]);
        }
      }
      return Math.round(lenKm * 2 * 10) / 10;
    }
    case "Polygon": {
      if (geometry.coordinates.length === 0) return 0;
      let area = ringSphericalAreaSqKm(geometry.coordinates[0]);
      for (let i = 1; i < geometry.coordinates.length; i++) {
        area -= ringSphericalAreaSqKm(geometry.coordinates[i]);
      }
      return Math.max(0, Math.round(area * 10) / 10);
    }
    case "MultiPolygon": {
      let total = 0;
      for (const poly of geometry.coordinates) {
        if (poly.length === 0) continue;
        let area = ringSphericalAreaSqKm(poly[0]);
        for (let i = 1; i < poly.length; i++) {
          area -= ringSphericalAreaSqKm(poly[i]);
        }
        total += Math.max(0, area);
      }
      return Math.round(total * 10) / 10;
    }
    case "GeometryCollection": {
      let total = 0;
      for (const g of geometry.geometries) {
        total += computeGeometryAreaSqKm(g);
      }
      return Math.round(total * 10) / 10;
    }
    default:
      return 0;
  }
}

export function computeDurationHours(validFrom: number, validTo: number): number {
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validTo <= validFrom) {
    return 0;
  }
  return Math.round(((validTo - validFrom) / 3600) * 10) / 10;
}
