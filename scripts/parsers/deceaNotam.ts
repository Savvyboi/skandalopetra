import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { HazardFeature } from "../../src/types/schema.ts";
import {
  computeDurationHours,
  computeGeometryAreaSqKm,
  parseIcaoNotamBodyCoords,
  parseNotamQLineCircle,
} from "../utils/geometry.ts";

const ENDPOINT = "https://api.decea.mil.br/aisweb/";
const BULLETINS = "https://ais.decea.mil.br/?i=notam";
const LOOKBACK_MINUTES = 90 * 24 * 60;

interface NotamRecord {
  id?: string;
  n?: string;
  s?: string;
  tp?: string;
  dt?: string;
  loc?: string;
  b?: string;
  c?: string;
  d?: string;
  e?: string;
  f?: string;
  g?: string;
  geo?: string;
}

function parseTime(value: string | undefined): number | undefined {
  const match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*EST)?$/.exec(value ?? "");
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return undefined;
  const date = new Date(Date.UTC(2000 + year, month - 1, day, hour, minute));
  return date.getUTCDate() === day ? date.getTime() / 1000 : undefined;
}

function parseAltitude(value: string | undefined): number | undefined {
  if (value === "GND" || value === "SFC") return 0;
  const flightLevel = /^FL\s*(\d{2,3})$/.exec(value ?? "");
  if (flightLevel && flightLevel[1] !== "999") return Number(flightLevel[1]) * 100;
  const feet = /^(\d+)\s*FT\s*(?:AMSL|MSL)$/.exec(value ?? "");
  return feet ? Number(feet[1]) : undefined;
}

function normalizeNotam(record: NotamRecord, nowSec: number): HazardFeature | null {
  if (record.tp !== "N" && record.tp !== "R") return null;
  const station = record.loc?.toUpperCase();
  if (!station || !/^[A-Z0-9]{4}$/.test(station) || !record.e) return null;
  const validFrom = parseTime(record.b);
  if (validFrom === undefined) return null;
  const issuedAt = parseTime(record.dt) ?? validFrom;
  const validTo = record.c === "PERM"
    ? Math.max(nowSec, validFrom) + 7 * 86400
    : parseTime(record.c);
  if (validTo === undefined || validTo <= validFrom) return null;

  const number = record.n?.toUpperCase().replace(/\s+/g, "").replace(/\/20(\d{2})$/, "/$1");
  const canonicalNumber = number && /^\d{4}\/\d{2}$/.test(number)
    ? `${record.s ?? ""}${number}`.toUpperCase()
    : number;
  const id = canonicalNumber && /^[A-Z]\d{4}\/\d{2}$/.test(canonicalNumber)
    ? `ICAO-NOTAM-${station}-${canonicalNumber.replace("/", "-")}`
    : record.id && /^\d+$/.test(record.id) ? `DECEA-NOTAM-${record.id}` : undefined;
  if (!id) return null;

  const token = /\b(\d{4}[NS])\s*(\d{5}[EW])[\s/]*(\d{3})\b/i.exec(record.geo ?? "");
  const coordinateGroup = token?.slice(1).join("").toUpperCase();
  const qGeometry = coordinateGroup && !/^0000[NS]00000[EW]/.test(coordinateGroup)
    ? parseNotamQLineCircle(coordinateGroup)
    : null;
  const positions = qGeometry ? [] : parseIcaoNotamBodyCoords(record.e.toUpperCase());
  const geometry = qGeometry ?? (positions.length === 1
    ? { type: "Point" as const, coordinates: positions[0] }
    : null);
  if (!geometry) return null;

  const rawText = [
    record.d && `D) ${record.d}`,
    `E) ${record.e}`,
    record.f && `F) ${record.f}`,
    record.g && `G) ${record.g}`,
  ].filter(Boolean).join("\n");
  const danger = /\b(?:CLSD|CLOSED|INTERDITAD[AO]S?|PROIBID[AO]S?|RESTRIT[AO]S?|DISPAROS?|MISSILE|GUNNERY|FOGUETES?)\b/i.test(record.e);
  return {
    type: "Feature",
    geometry,
    properties: {
      id,
      domain: "notam",
      subType: "NOTAM",
      severity: danger ? "danger" : "warning",
      title: `${station} NOTAM ${canonicalNumber ?? record.id}`,
      rawText,
      stationOrArea: station,
      issuer: "DECEA (Brazil)",
      country: "Brazil",
      region: "South America",
      areaSqKm: computeGeometryAreaSqKm(geometry),
      durationHours: computeDurationHours(validFrom, validTo),
      issuedAt,
      validFrom,
      validTo,
      altitudeMinFt: parseAltitude(record.f),
      altitudeMaxFt: parseAltitude(record.g),
      sourceUrl: BULLETINS,
      geometryNote: qGeometry
        ? "The published centre and radius are a reference for the NOTAM. The bulletin defines the affected area."
        : "Reference position extracted from the NOTAM text.",
    },
  };
}

function parseNotamResponse(xml: string, nowSec: number): HazardFeature[] {
  if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("Invalid XML");
  }
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  const data = parser.parse(xml) as {
    aisweb?: { notam?: object };
    notam?: object;
  };
  const container = data.aisweb?.notam ?? data.notam;
  if (!container || typeof container !== "object") throw new Error("Missing NOTAM container");
  const records = Object.entries(container)
    .filter(([key]) => !key.startsWith("@_"))
    .flatMap(([, value]) => Array.isArray(value) ? value : [value])
    .filter((value): value is NotamRecord => value !== null && typeof value === "object");

  const features: HazardFeature[] = [];
  for (const record of records) {
    const feature = normalizeNotam(record, nowSec);
    if (feature) features.push(feature);
  }
  console.log(`[deceaNotam] Parsed ${features.length} geolocated NOTAMs from ${records.length} records`);
  return features;
}

export async function fetchDeceaNotamHazards(nowSec: number): Promise<HazardFeature[]> {
  const key = process.env.DECEA_API_KEY?.trim();
  const pass = process.env.DECEA_API_PASS?.trim();
  if (!key || !pass) return [];

  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    apiKey: key,
    apiPass: pass,
    area: "notam",
    dist: "N",
    all: "1",
    minutes: String(LOOKBACK_MINUTES),
  }).toString();
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "GlobalHazardTracker/1.0 (+https://github.com)", Accept: "application/xml" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      console.warn(`[deceaNotam] HTTP ${response.status}`);
      return [];
    }
    return parseNotamResponse(await response.text(), nowSec);
  } catch {
    // The query string contains credentials, so avoid logging the URL or raw error.
    console.warn("[deceaNotam] Request or XML normalization failed");
    return [];
  }
}
