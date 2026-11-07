import circle from "@turf/circle";
import type { Geometry } from "geojson";

/**
 * Extracts Degrees-Decimal-Minutes coordinates from NGA / NAVTEX message text.
 * Matches patterns like: 58-12.5N 019-30.0E or 12-34.56S 123-45.67W
 */
export function parseNgaCoordinates(rawText: string): [number, number][] {
  const ddmRegex =
    /(\d{1,2})-(\d{2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{2}(?:\.\d+)?)\s*([EW])/gi;
  const coords: [number, number][] = [];
  let match: RegExpExecArray | null;

  while ((match = ddmRegex.exec(rawText)) !== null) {
    const latDeg = parseInt(match[1], 10);
    const latMin = parseFloat(match[2]);
    const latHem = match[3].toUpperCase();
    const lonDeg = parseInt(match[4], 10);
    const lonMin = parseFloat(match[5]);
    const lonHem = match[6].toUpperCase();

    let lat = latDeg + latMin / 60;
    let lon = lonDeg + lonMin / 60;
    if (latHem === "S") lat = -lat;
    if (lonHem === "W") lon = -lon;

    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      coords.push([Number(lon.toFixed(5)), Number(lat.toFixed(5))]);
    }
  }
  return coords;
}

/**
 * Converts extracted coordinate pairs into Point, LineString, or closed Polygon.
 */
export function coordsToGeoJsonGeometry(
  coords: [number, number][]
): Geometry | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) {
    return { type: "Point", coordinates: coords[0] };
  }
  if (coords.length === 2) {
    return { type: "LineString", coordinates: coords };
  }

  const ring = [...coords];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push(first);
  }
  return { type: "Polygon", coordinates: [ring] };
}

/**
 * Parses an ICAO NOTAM Q-line coordinate/radius token (e.g., "5128N00027W005")
 * into a 32-vertex GeoJSON Polygon (radius in Nautical Miles).
 */
export function parseNotamQLineCircle(qCoordToken: string): Geometry | null {
  const match = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3})$/.exec(
    qCoordToken.trim()
  );
  if (!match) return null;

  let lat = parseInt(match[1], 10) + parseInt(match[2], 10) / 60;
  if (match[3] === "S") lat = -lat;

  let lon = parseInt(match[4], 10) + parseInt(match[5], 10) / 60;
  if (match[6] === "W") lon = -lon;

  const radiusNm = parseInt(match[7], 10);
  if (radiusNm <= 0 || radiusNm >= 999) {
    return {
      type: "Point",
      coordinates: [Number(lon.toFixed(5)), Number(lat.toFixed(5))],
    };
  }

  const radiusKm = radiusNm * 1.852;
  const poly = circle([lon, lat], radiusKm, { steps: 32, units: "kilometers" });
  return poly.geometry;
}

/**
 * Extracts "CANCEL THIS MSG DDHHMMZ MON YY" into a Unix timestamp in seconds.
 */
export function parseNgaCancelTimestamp(rawText: string): number | null {
  const match =
    /CANCEL\s+THIS\s+MSG\s+(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{2})/i.exec(
      rawText
    );
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const hour = parseInt(match[2], 10);
  const minute = parseInt(match[3], 10);
  const monthStr = match[4].toUpperCase();
  const year = 2000 + parseInt(match[5], 10);

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
  if (month === undefined) return null;

  return Math.floor(Date.UTC(year, month, day, hour, minute, 0) / 1000);
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
  return circle([lon, lat], radiusKm, { steps: 32, units: "kilometers" }).geometry;
}
