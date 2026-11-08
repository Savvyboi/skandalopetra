import type { Geometry } from "geojson";
import type { HazardFeature, HazardSeverity } from "../../src/types/schema.ts";
import {
  computeDurationHours,
  computeGeometryAreaSqKm,
  coordsToGeoJsonGeometry,
  createNmCircleGeometry,
  parseIcaoNotamBodyCoords,
  parseNgaCoordinates,
  parseNotamQLineCircle,
} from "../utils/geometry.ts";
import { resolveIcaoMetadata } from "../utils/icaoRegions.ts";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface FaaSearchNotamItem {
  facilityDesignator?: string;
  notamNumber?: string;
  issueDate?: string;
  startDate?: string;
  endDate?: string;
  icaoMessage?: string;
  traditionalMessage?: string;
  plainLanguageMessage?: string;
  traditionalMessageFrom4thWord?: string;
  icaoId?: string;
  airportName?: string;
  cancelledOrExpired?: boolean;
  status?: string;
}

interface FaaSearchResponse {
  notamList?: FaaSearchNotamItem[];
  totalNotamCount?: number;
  error?: string;
}

/**
 * 10 balanced global Flight Information Region (FIR) & international hub batches,
 * interleaved across all continents so sequential polite polling (750ms spacing)
 * never trips Akamai burst limits and covers every global region evenly.
 */
const GLOBAL_FIR_BATCHES: Array<{ name: string; designators: string }> = [
  {
    name: "Oceania & South Pacific",
    designators: "YMMM,YBBB,YSSY,YMML,NZZC,NZZO,NZAA,NFFF,AYPM,NWWW",
  },
  {
    name: "South America",
    designators: "SBAZ,SBBS,SBCW,SBRE,SAEF,SACF,SAVF,SCFZ,SCTZ,SKED,SPIM,SVZM,SEFG,SUEO",
  },
  {
    name: "East Asia & Japan",
    designators: "RJJJ,RJTT,RJBB,ROAH,RKRR,RKSI,VHHK,RCAA,ZBPE,ZSHA,ZGZU,ZMUB",
  },
  {
    name: "Southeast & South Asia",
    designators: "VTBB,VVTS,VVHN,WMFC,WSJC,WIIF,RPHI,VIDF,VABF,VECF,VOMF,OPKR,VCCF,VGFR",
  },
  {
    name: "Middle East & Arabian Gulf",
    designators: "LLLL,OJAC,OLBB,ORBB,OIIX,OMAE,OEJD,OTDF,OBBB,OOMM,OKAC,OYSC",
  },
  {
    name: "North & Sub-Saharan Africa",
    designators: "HECC,HLLL,DTTC,DAAA,GMMM,GOOO,DNKK,DGAC,FCCC,HKNA,HAAA,FAJA,FACA,FMMM",
  },
  {
    name: "UK, Western & Northern Europe",
    designators: "EGTT,EGPX,EISN,LFFF,LFMM,LFBB,EHAA,EBBU,LSAS,ESAA,ENOR,EFIN,EKDK,EVRR,EYVL,EETT",
  },
  {
    name: "Central, Southern & Eastern Europe",
    designators: "EDGG,EDMM,LOVV,EPWW,LKAA,LECM,LPPC,LIRR,LIMM,LGGG,LCCC,LTAA,LRBB,LHCC,LDZO,UKBV,UGGG",
  },
  {
    name: "Mexico, Central America & Caribbean",
    designators: "MMFR,MMEX,MMMX,MHTG,MPZL,MKJK,MUFH,MDCS,TJZS,TTZP",
  },
  {
    name: "North Atlantic, Polar & US Oceanic",
    designators: "BIRD,EGGX,KZNY,KZDC,KZMA,KZHU,KZLA,KZOA,KZSE,PAZA,PHZH",
  },
];

const NAV_CANADA_SITES = [
  "CYYZ",
  "CYVR",
  "CYUL",
  "CYYC",
  "CYEG",
  "CYWG",
  "CYOW",
  "CYHZ",
  "CYQB",
  "CYYT",
  "CYYJ",
  "CYXE",
  "CYZF",
  "CYXY",
  "CYFB",
];

const QCODE_SUBJECT_LABELS: Record<string, string> = {
  RT: "Restricted Area",
  RD: "Danger Area",
  RP: "Prohibited Area",
  RR: "Restricted Airspace",
  RA: "Airspace Reservation",
  RM: "Military Operating Area",
  WM: "Missile / Gunnery Firing",
  WP: "Parachute Jumping",
  WU: "UAV / Drone Activity",
  WE: "Military / Air Exercises",
  WZ: "Rocket / Pyrotechnics",
  WA: "Air Display",
  WB: "Aerobatics",
  WG: "Glider Flying",
  WL: "Captive Balloon / Ascent",
  WO: "Laser / Searchlight",
  WT: "Mass Aircraft Movement",
  WV: "Formation Flight",
  WW: "Volcanic / Significant Hazard",
  MR: "Runway Hazard / Closure",
  FA: "Aerodrome Status",
  OB: "Obstacle / Crane",
  OL: "Obstacle Light Outage",
  NM: "VOR/DME Status",
  NB: "NDB Status",
  IC: "ILS Status",
  GA: "GNSS / GPS Interference",
  GW: "GNSS / GPS Jamming/Anomaly",
  AF: "FIR Airspace Notice",
  AR: "ATS Route Restriction",
  AN: "Area Navigation Route",
};

function describeQCode(qCode: string): string {
  if (qCode.length < 3 || !qCode.startsWith("Q")) return "NOTAM";
  const subj = qCode.slice(1, 3).toUpperCase();
  const cond = qCode.slice(3, 5).toUpperCase();
  const base = QCODE_SUBJECT_LABELS[subj];
  if (base) {
    if (cond === "LC") return `${base} (Closed)`;
    if (cond === "CA") return `${base} (Active)`;
    if (cond === "AS") return `${base} (Unserviceable)`;
    return base;
  }
  if (cond === "LC") return "Closed Facility / Airspace";
  return "Airspace / Operational NOTAM";
}

function parseFaaNotamSearchDate(
  raw: string | undefined,
  fallbackSec: number
): number {
  if (!raw) return fallbackSec;
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed || trimmed === "PERM" || trimmed === "UFN") {
    return fallbackSec;
  }
  // Format: "11/08/2026 0800" or "11/08/2026 2359EST"
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})(\d{2})/.exec(trimmed);
  if (m) {
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    const hour = parseInt(m[4], 10);
    const min = parseInt(m[5], 10);
    return Math.floor(Date.UTC(year, month, day, hour, min, 0) / 1000);
  }
  const ms = Date.parse(raw);
  return !Number.isNaN(ms) ? Math.floor(ms / 1000) : fallbackSec;
}

function parseIcaoTenDigitTimestamp(yyMMddHHmm: string): number | null {
  if (!/^\d{10}$/.test(yyMMddHHmm)) return null;
  const year = 2000 + parseInt(yyMMddHHmm.slice(0, 2), 10);
  const month = parseInt(yyMMddHHmm.slice(2, 4), 10) - 1;
  const day = parseInt(yyMMddHHmm.slice(4, 6), 10);
  const hour = parseInt(yyMMddHHmm.slice(6, 8), 10);
  const min = parseInt(yyMMddHHmm.slice(8, 10), 10);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  return Math.floor(Date.UTC(year, month, day, hour, min, 0) / 1000);
}

function approxDistKm(a: [number, number], b: [number, number]): number {
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b[1] - a[1]);
  const dLon = toR(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function extractBodySectionE(icaoMessage: string): string {
  const eMatch = /\bE\)\s*([\s\S]*?)(?:\n\s*[FG]\)\s|$)/.exec(icaoMessage);
  return eMatch ? eMatch[1].trim() : icaoMessage;
}

function parseQCenterLonLat(qCoord8Or11: string): [number, number] | null {
  const m = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])/.exec(
    qCoord8Or11.trim()
  );
  if (!m) return null;
  let lat = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  if (m[3] === "S") lat = -lat;
  let lon = parseInt(m[4], 10) + parseInt(m[5], 10) / 60;
  if (m[6] === "W") lon = -lon;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [Number(lon.toFixed(5)), Number(lat.toFixed(5))];
}

function buildNotamGeometry(
  icaoMessage: string,
  qToken: string | null,
  qRadiusNm: number
): Geometry | null {
  const bodyE = extractBodySectionE(icaoMessage);
  const qCenter = qToken ? parseQCenterLonLat(qToken) : null;

  // 1. Check for explicit polygon/line coordinates in Section E
  const icaoBodyCoords = parseIcaoNotamBodyCoords(bodyE);
  const ddmBodyCoords =
    icaoBodyCoords.length >= 3 ? icaoBodyCoords : parseNgaCoordinates(bodyE);
  const candidateCoords =
    icaoBodyCoords.length >= ddmBodyCoords.length
      ? icaoBodyCoords
      : ddmBodyCoords;

  const filteredCoords = qCenter
    ? candidateCoords.filter(
        (pt) => approxDistKm(pt, qCenter) <= Math.max(qRadiusNm * 2.5 * 1.852, 850)
      )
    : candidateCoords;

  if (filteredCoords.length >= 3) {
    return coordsToGeoJsonGeometry(filteredCoords);
  }

  // 2. Check for explicit circle radius in Section E ("RADIUS 5NM", "RADIUS OF 10 NM", "WI 3NM OF")
  const radMatch =
    /(?:RADIUS(?:\s+OF)?\s+([\d.]+)\s*NM|WI\s+([\d.]+)\s*NM\s+(?:RADIUS|OF))/i.exec(
      bodyE
    );
  const explicitRadiusNm = radMatch
    ? parseFloat(radMatch[1] ?? radMatch[2] ?? "0")
    : NaN;

  if (
    Number.isFinite(explicitRadiusNm) &&
    explicitRadiusNm > 0 &&
    explicitRadiusNm <= 150
  ) {
    const center = filteredCoords[0] ?? qCenter;
    if (center) {
      return createNmCircleGeometry(center[0], center[1], explicitRadiusNm);
    }
  }

  // 3. Fall back to ICAO Q-line circle (capped at 150 NM so whole-FIR 999 NM notices become clean Points)
  if (qToken) {
    return parseNotamQLineCircle(qToken, 150);
  }

  if (filteredCoords.length > 0) {
    return coordsToGeoJsonGeometry(filteredCoords);
  }

  return null;
}

interface NavCanadaAlphaItem {
  pk?: string;
  location?: string | null;
  startValidity?: string | null;
  endValidity?: string | null;
  text?: string;
}

async function fetchNavCanadaItems(): Promise<FaaSearchNotamItem[]> {
  try {
    const qs =
      NAV_CANADA_SITES.map((s) => `site=${s}`).join("&") + "&alpha=notam";
    const res = await fetch(
      `https://plan.navcanada.ca/weather/api/alpha/?${qs}`,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(18000),
      }
    );
    if (!res.ok) return [];
    const payload = (await res.json()) as { data?: NavCanadaAlphaItem[] };
    const out: FaaSearchNotamItem[] = [];

    for (const row of payload.data ?? []) {
      let rawIcao = "";
      if (row.text) {
        try {
          const parsed = JSON.parse(row.text) as {
            raw?: string;
            english?: string;
          };
          rawIcao = (parsed.raw || parsed.english || "").trim();
        } catch {
          rawIcao = row.text.trim();
        }
      }
      if (!rawIcao) continue;

      // Strip outer parens e.g. "(D4972/26 NOTAMN\nQ) CZYZ/...)"
      const cleaned = rawIcao.replace(/^\(/, "").replace(/\)$/, "").trim();
      const numMatch = /^([A-Z]\d{4}\/\d{2})\b/.exec(cleaned);
      const aMatch = /\bA\)\s*([A-Z0-9]{4})\b/.exec(cleaned);
      const qFirMatch = /\bQ\)\s*([A-Z]{4})\//.exec(cleaned);
      const icaoId = (row.location || aMatch?.[1] || qFirMatch?.[1] || "CZUL")
        .trim()
        .toUpperCase();

      out.push({
        icaoId,
        notamNumber: numMatch?.[1] ?? (row.pk ? `NC-${row.pk}` : ""),
        issueDate: row.startValidity ?? undefined,
        startDate: row.startValidity ?? undefined,
        endDate: row.endValidity ?? "PERM",
        icaoMessage: cleaned,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchSearchPage(
  designators: string,
  offset: number,
  cookieHeader: string
): Promise<{ status: number; data: FaaSearchResponse | null }> {
  try {
    const body = new URLSearchParams({
      searchType: "0",
      designatorsForLocation: designators,
      sortColumns: "5 true", // Sort by endDate ascending -> active & near-term operational NOTAMs first!
      sortDirection: "true",
      offset: String(offset),
    });

    const res = await fetch("https://notams.aim.faa.gov/notamSearch/search", {
      method: "POST",
      headers: {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://notams.aim.faa.gov",
        Referer: "https://notams.aim.faa.gov/notamSearch/nsapp.html",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(18000),
    });

    if (!res.ok) return { status: res.status, data: null };
    return { status: res.status, data: (await res.json()) as FaaSearchResponse };
  } catch {
    return { status: 0, data: null };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFaaGlobalBatches(): Promise<FaaSearchNotamItem[]> {
  let cookieHeader = "";
  try {
    const init = await fetch(
      "https://notams.aim.faa.gov/notamSearch/nsapp.html",
      {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (init.status === 403) {
      console.warn(
        "[globalNotam] FAA notamSearch edge rate-limit cooldown active (HTTP 403); retaining cached global NOTAMs + NAV CANADA live feed"
      );
      return [];
    }
    const rawCookies =
      typeof init.headers.getSetCookie === "function"
        ? init.headers.getSetCookie()
        : [];
    cookieHeader = rawCookies.map((c) => c.split(";")[0]).join("; ");
  } catch {
    // Proceed without initial session cookie
  }

  const allItems: FaaSearchNotamItem[] = [];
  for (let i = 0; i < GLOBAL_FIR_BATCHES.length; i++) {
    if (i > 0) await sleep(750);
    const batch = GLOBAL_FIR_BATCHES[i];
    const { status, data } = await fetchSearchPage(
      batch.designators,
      0,
      cookieHeader
    );
    if (status === 403) {
      console.warn(
        `[globalNotam] FAA notamSearch rate limit reached at batch ${i + 1}/${GLOBAL_FIR_BATCHES.length} (${batch.name}); stopping further pages cleanly`
      );
      break;
    }
    if (data?.notamList?.length) {
      allItems.push(...data.notamList);
    }
  }
  return allItems;
}

export async function fetchGlobalIcaoNotams(
  nowSec: number
): Promise<HazardFeature[]> {
  const seenKeys = new Set<string>();
  const features: HazardFeature[] = [];

  const [navCanadaItems, faaGlobalItems] = await Promise.all([
    fetchNavCanadaItems(),
    fetchFaaGlobalBatches(),
  ]);

  const batchItems = [navCanadaItems, faaGlobalItems];

  for (const list of batchItems) {
    for (const item of list) {
      if (item.cancelledOrExpired) continue;

      const icaoLocation = (
        item.icaoId ||
        item.facilityDesignator ||
        ""
      )
        .trim()
        .toUpperCase();
      const notamNumber = (item.notamNumber || "").trim().toUpperCase();
      const rawMsg = (
        item.icaoMessage ||
        item.traditionalMessage ||
        item.plainLanguageMessage ||
        ""
      ).trim();

      if (!icaoLocation || !rawMsg) continue;

      const dedupKey = `${icaoLocation}-${notamNumber || rawMsg.slice(0, 48)}`;
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);

      // Parse ICAO Q-line: Q) LGGG/QRTCA/IV/BO /W /000/070/3813N02353E013
      const qMatch =
        /Q\)\s*([A-Z]{4})\/(Q[A-Z]{4})\/[^/]*\/[^/]*\/[^/]*\/(\d{3})\/(\d{3})\/(\d{4}[NS]\d{5}[EW](\d{3}))/.exec(
          rawMsg
        );

      const qFir = qMatch?.[1] ?? icaoLocation;
      const qCode = qMatch?.[2] ?? "";
      const lowerFl = qMatch ? parseInt(qMatch[3], 10) : undefined;
      const upperFl = qMatch ? parseInt(qMatch[4], 10) : undefined;
      const qToken = qMatch?.[5] ?? null;
      const qRadiusNm = qMatch ? parseInt(qMatch[6], 10) : 0;

      const geometry = buildNotamGeometry(rawMsg, qToken, qRadiusNm);
      if (!geometry) continue;

      // Parse B) and C) 10-digit ICAO timestamps if present, else startDate/endDate
      const bMatch = /\bB\)\s*(\d{10})\b/.exec(rawMsg);
      const cMatch = /\bC\)\s*(\d{10}|PERM)\b/.exec(rawMsg);

      const issuedAt = parseFaaNotamSearchDate(item.issueDate, nowSec);
      const validFrom =
        (bMatch ? parseIcaoTenDigitTimestamp(bMatch[1]) : null) ??
        parseFaaNotamSearchDate(item.startDate, issuedAt);

      let validTo: number;
      if (cMatch?.[1] === "PERM" || item.endDate?.trim().toUpperCase() === "PERM") {
        validTo = nowSec + 14 * 86400;
      } else {
        validTo =
          (cMatch ? parseIcaoTenDigitTimestamp(cMatch[1]) : null) ??
          parseFaaNotamSearchDate(item.endDate, nowSec + 7 * 86400);
      }
      if (validTo <= validFrom) {
        validTo = Math.max(validFrom + 3600, nowSec + 24 * 3600);
      }

      const altitudeMinFt =
        lowerFl !== undefined && Number.isFinite(lowerFl)
          ? lowerFl * 100
          : undefined;
      const altitudeMaxFt =
        upperFl !== undefined && Number.isFinite(upperFl)
          ? upperFl >= 999
            ? 60000
            : upperFl * 100
          : undefined;

      const qCategory = describeQCode(qCode);
      const isDanger =
        /^Q(RP|RT|RD|WM|WZ|WW|GA|GW)/.test(qCode) ||
        /\b(PROHIBITED|RESTRICTED|DANGER\s+AREA|MISSILE|ROCKET|GUNNERY|FIRING|LIVE\s+FIRE|GPS\s+JAM|GNSS\s+INTERFERENCE|CLOSED|CLSD|UNSERVICEABLE|VOLCANIC)\b/i.test(
          rawMsg
        );
      const isInfo =
        !isDanger &&
        (/^Q(AF|AN|NM|NB|OL)/.test(qCode) || qRadiusNm >= 300);

      const severity: HazardSeverity = isDanger
        ? "danger"
        : isInfo
        ? "info"
        : "warning";

      const authority = resolveIcaoMetadata(
        icaoLocation.endsWith("XX") ? qFir : icaoLocation,
        "notam"
      );

      const areaSqKm = computeGeometryAreaSqKm(geometry);
      const durationHours = computeDurationHours(validFrom, validTo);
      const safeNum = (notamNumber || String(validFrom)).replace(/[^A-Z0-9-]/g, "-");

      features.push({
        type: "Feature",
        geometry,
        properties: {
          id: `ICAO-NOTAM-${icaoLocation}-${safeNum}`,
          domain: "notam",
          subType: "NOTAM",
          severity,
          title: `${icaoLocation} ${notamNumber} — ${qCategory}`.trim(),
          rawText: item.airportName
            ? `Location: ${item.airportName} (${icaoLocation})\n\n${rawMsg}`
            : rawMsg,
          stationOrArea: icaoLocation,
          issuer: authority.issuer,
          country: authority.country,
          region: authority.region,
          areaSqKm,
          durationHours,
          issuedAt,
          validFrom,
          validTo,
          ...(altitudeMinFt !== undefined ? { altitudeMinFt } : {}),
          ...(altitudeMaxFt !== undefined ? { altitudeMaxFt } : {}),
        },
      });
    }
  }

  console.log(
    `[globalNotam] Parsed ${features.length} global ICAO NOTAMs across ${GLOBAL_FIR_BATCHES.length} worldwide FIR regions`
  );
  return features;
}
