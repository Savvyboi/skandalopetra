import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureCollection, Geometry } from "geojson";
import type {
  HazardFeature,
  HazardRegion,
  HazardSeverity,
  HazardSubType,
} from "../../src/types/schema.ts";
import {
  computeDurationHours,
  computeGeometryAreaSqKm,
  coordsToGeoJsonGeometry,
  createNmCircleGeometry,
  parseNgaCancelTimestamp,
  parseNgaCoordinates,
} from "../utils/geometry.ts";
import { resolveNavAreaMetadata } from "../utils/icaoRegions.ts";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FETCH_HEADERS = {
  "User-Agent": BROWSER_UA,
  Accept: "application/json, text/plain, text/html, */*",
};

const DANGER_REGEX =
  /HAZARDOUS|ROCKET|MISSILE|SPACE\s+DEBRIS|GUNNERY|FIRING|LIVE\s+FIRE|MINE|DERELICT|PIRACY|TSUNAMI|UNEXPLODED|ORDNANCE|HURRICANE|TYPHOON|CYCLONE|STORM\s+WARNING/i;

const ARABIC_TO_ROMAN: Record<string, string> = {
  "1": "I",
  "2": "II",
  "3": "III",
  "4": "IV",
  "5": "V",
  "6": "VI",
  "7": "VII",
  "8": "VIII",
  "9": "IX",
  "10": "X",
  "11": "XI",
  "12": "XII",
  "13": "XIII",
  "14": "XIV",
  "15": "XV",
  "16": "XVI",
  "17": "XVII",
  "18": "XVIII",
  "19": "XIX",
  "20": "XX",
  "21": "XXI",
  A: "IV",
  HYDROLANT: "IV",
  P: "XII",
  HYDROPAC: "XII",
  C: "XVIII",
  HYDROARC: "XVIII",
};

function normalizeNavAreaCode(raw: unknown): string {
  const cleaned = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/^NAVAREA\s+/i, "");
  return ARABIC_TO_ROMAN[cleaned] ?? cleaned;
}

function decodeHtml(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(parseInt(dec, 10))
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function stripHtmlTags(html: string): string {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

async function loadNavAreaBoundaries(): Promise<Map<string, Geometry>> {
  const map = new Map<string, Geometry>();
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const filePath = path.resolve(
      __dirname,
      "../../public/boundaries/navareas.geojson"
    );
    const raw = await fs.readFile(filePath, "utf8");
    const fc = JSON.parse(raw) as FeatureCollection<
      Geometry,
      { navArea?: string }
    >;
    for (const feature of fc.features ?? []) {
      const code = normalizeNavAreaCode(feature.properties?.navArea);
      if (code && feature.geometry) {
        map.set(code, feature.geometry);
      }
    }
  } catch (err) {
    console.warn(
      "[ngaMaritime] Could not load navareas.geojson fallback boundaries:",
      err instanceof Error ? err.message : err
    );
  }
  return map;
}

function parseMaritimeIssueDate(raw: unknown, fallbackSec: number): number {
  if (!raw) return fallbackSec;
  const str = String(raw).trim();
  if (!str) return fallbackSec;

  // Format: DDHHMMZ MON YYYY | DDHHMM UTC Nov 26
  const milMatch =
    /(\d{2})(\d{2})(\d{2})\s*(?:Z|UTC)\s+([A-Za-z]{3})\s+(\d{2,4})/i.exec(str);
  if (milMatch) {
    const day = parseInt(milMatch[1], 10);
    const hour = parseInt(milMatch[2], 10);
    const minute = parseInt(milMatch[3], 10);
    const monStr = milMatch[4].toUpperCase();
    const yrRaw = parseInt(milMatch[5], 10);
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
    const month = months[monStr];
    if (month !== undefined) {
      return Math.floor(Date.UTC(year, month, day, hour, minute, 0) / 1000);
    }
  }

  // Format: YYYY/MM/DD HH UTC (JCG)
  const jcgMatch = /(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2})\s*UTC/i.exec(str);
  if (jcgMatch) {
    return Math.floor(
      Date.UTC(
        parseInt(jcgMatch[1], 10),
        parseInt(jcgMatch[2], 10) - 1,
        parseInt(jcgMatch[3], 10),
        parseInt(jcgMatch[4], 10),
        0,
        0
      ) / 1000
    );
  }

  const parsedMs = Date.parse(str);
  if (!Number.isNaN(parsedMs)) {
    return Math.floor(parsedMs / 1000);
  }

  return fallbackSec;
}

function parseCompactMarineCoords(text: string): [number, number][] {
  const coords: [number, number][] = [];

  // 1. Explicit Latitude/Longitude labels (e.g. BoM Tropical Cyclone advisories)
  const latLonLabeled =
    /Latitude:\s*(\d{1,2}(?:\.\d+)?)\s*([NS])[\s\S]{0,40}?Longitude:\s*(\d{1,3}(?:\.\d+)?)\s*([EW])/gi;
  let m: RegExpExecArray | null;
  while ((m = latLonLabeled.exec(text)) !== null) {
    let lat = parseFloat(m[1]);
    if (m[2].toUpperCase() === "S") lat = -lat;
    let lon = parseFloat(m[3]);
    if (m[4].toUpperCase() === "W") lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      coords.push([Number(lon.toFixed(4)), Number(lat.toFixed(4))]);
    }
  }
  if (coords.length > 0) return coords;

  // 2. Compact WMO degrees: "34S053W", "67S 134W", "54.5N 152.0E"
  const regex =
    /\b(\d{1,2}(?:\.\d+)?)\s*([NS])\s*(\d{1,3}(?:\.\d+)?)\s*([EW])\b/gi;
  while ((m = regex.exec(text)) !== null) {
    let lat = parseFloat(m[1]);
    const latH = m[2].toUpperCase();
    let lon = parseFloat(m[3]);
    const lonH = m[4].toUpperCase();
    if (latH === "S") lat = -lat;
    if (lonH === "W") lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      coords.push([Number(lon.toFixed(4)), Number(lat.toFixed(4))]);
    }
  }
  return coords;
}

function buildFeature(params: {
  id: string;
  subType: HazardSubType;
  severity: HazardSeverity;
  title: string;
  rawText: string;
  stationOrArea: string;
  issuer: string;
  country: string;
  region: HazardRegion;
  geometry: Geometry;
  issuedAt: number;
  validFrom: number;
  validTo: number;
}): HazardFeature {
  return {
    type: "Feature",
    geometry: params.geometry,
    properties: {
      id: params.id,
      domain: "maritime",
      subType: params.subType,
      severity: params.severity,
      title: params.title,
      rawText: params.rawText,
      stationOrArea: params.stationOrArea,
      issuer: params.issuer,
      country: params.country,
      region: params.region,
      areaSqKm: computeGeometryAreaSqKm(params.geometry),
      durationHours: computeDurationHours(params.validFrom, params.validTo),
      issuedAt: params.issuedAt,
      validFrom: params.validFrom,
      validTo: params.validTo,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. NGA Maritime Safety Information (Global Broadcast Warnings)
// ---------------------------------------------------------------------------
interface NgaBroadcastWarning {
  msgYear?: number | string;
  msgNumber?: number | string;
  navArea?: string;
  text?: string;
  issueDate?: string;
}

async function fetchNgaMsiBroadcasts(
  nowSec: number,
  boundaries: Map<string, Geometry>
): Promise<HazardFeature[]> {
  const url =
    "https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=active";
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    console.warn(`[ngaMaritime] NGA MSI HTTP ${res.status}`);
    return [];
  }

  const payload = (await res.json()) as
    | NgaBroadcastWarning[]
    | { "broadcast-warn"?: NgaBroadcastWarning[] };
  const warnings = Array.isArray(payload)
    ? payload
    : Array.isArray(payload["broadcast-warn"])
    ? payload["broadcast-warn"]
    : [];

  const results: HazardFeature[] = [];
  for (const w of warnings) {
    const rawText = String(w.text ?? "").trim();
    if (!rawText || /WARNINGS\s+IN\s+FORCE/i.test(rawText)) continue;

    const navArea = normalizeNavAreaCode(w.navArea || "IV");
    const msgYear = String(
      w.msgYear ?? new Date(nowSec * 1000).getUTCFullYear()
    );
    const msgNumber = String(w.msgNumber ?? Math.abs(hashCode(rawText)));

    const issuedAt = parseMaritimeIssueDate(w.issueDate, nowSec);
    const validFrom = issuedAt;
    const cancelSec = parseNgaCancelTimestamp(rawText);
    const validTo =
      cancelSec && cancelSec > validFrom ? cancelSec : nowSec + 7 * 86400;

    const coords = parseNgaCoordinates(rawText);
    const geometry =
      coordsToGeoJsonGeometry(coords) ?? boundaries.get(navArea) ?? null;
    if (!geometry) continue;

    const meta = resolveNavAreaMetadata(navArea);
    results.push(
      buildFeature({
        id: `NGA-NAVAREA-${navArea}-${msgYear}-${msgNumber}`,
        subType: "NAVAREA",
        severity: DANGER_REGEX.test(rawText) ? "danger" : "warning",
        title: `NAVAREA ${navArea} Warning ${msgNumber}/${msgYear}`,
        rawText,
        stationOrArea: `NAVAREA ${navArea}`,
        issuer: "NGA MSI (US)",
        country: meta.country,
        region: meta.region,
        geometry,
        issuedAt,
        validFrom,
        validTo,
      })
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. UKHO Admiralty (NAVAREA I & UK Coastal WZ Warnings)
// ---------------------------------------------------------------------------
async function fetchUkhoAdmiraltyWarnings(
  nowSec: number
): Promise<HazardFeature[]> {
  const url = "https://msi.admiralty.co.uk/RadioNavigationalWarnings";
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    console.warn(`[ngaMaritime] UKHO HTTP ${res.status}`);
    return [];
  }

  const html = await res.text();
  const detailBlocks = [
    ...html.matchAll(/<div class="warning-detail">([\s\S]*?)<\/div>/gi),
  ];
  const seenRefs = new Set<string>();
  const results: HazardFeature[] = [];

  for (const m of detailBlocks) {
    const block = m[1];
    const warnType = stripHtmlTags(
      /<h1[^>]*class="warning-type"[^>]*>([\s\S]*?)<\/h1>/i.exec(block)?.[1] ??
        ""
    );
    const ref = stripHtmlTags(
      /<h2[^>]*class="warning-reference"[^>]*>([\s\S]*?)<\/h2>/i.exec(
        block
      )?.[1] ?? ""
    );
    const dtg = stripHtmlTags(
      /<h3[^>]*class="warning-date-time"[^>]*>([\s\S]*?)<\/h3>/i.exec(
        block
      )?.[1] ?? ""
    );
    const body = stripHtmlTags(
      /<pre[^>]*class="warning-description"[^>]*>([\s\S]*?)<\/pre>/i.exec(
        block
      )?.[1] ?? ""
    );

    if (!ref || !body || seenRefs.has(ref)) continue;
    seenRefs.add(ref);

    if (/WARNINGS\s+IN\s+FORCE/i.test(body)) continue;

    const ddm = parseNgaCoordinates(body);
    const coords = ddm.length > 0 ? ddm : parseCompactMarineCoords(body);
    const geometry = coordsToGeoJsonGeometry(coords);
    if (!geometry) continue;

    const isNavarea = /NAVAREA/i.test(warnType) || /NAVAREA/i.test(ref);
    const subType: HazardSubType = isNavarea ? "NAVAREA" : "NAVTEX";
    const issuedAt = parseMaritimeIssueDate(dtg, nowSec);
    const cancelSec = parseNgaCancelTimestamp(body);
    const validTo =
      cancelSec && cancelSec > issuedAt ? cancelSec : nowSec + 7 * 86400;

    const firstHeadline =
      body
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 2 && !/^\d+\.$/.test(l)) ?? "";

    results.push(
      buildFeature({
        id: `UKHO-${ref.replace(/[^A-Za-z0-9]+/g, "-")}`,
        subType,
        severity: DANGER_REGEX.test(body) ? "danger" : "warning",
        title: firstHeadline ? `${ref} — ${firstHeadline}` : ref,
        rawText: `${ref} (${dtg})\n\n${body}`,
        stationOrArea: isNavarea ? "NAVAREA I" : "UK Coastal",
        issuer: "UKHO Admiralty",
        country: "United Kingdom",
        region: "Europe",
        geometry,
        issuedAt,
        validFrom: issuedAt,
        validTo,
      })
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// 3. Danish Maritime Authority — Niord Public API (Baltic & North Sea GeoJSON)
// ---------------------------------------------------------------------------
interface NiordDesc {
  lang?: string;
  name?: string;
  title?: string;
  subject?: string;
  details?: string;
}

interface NiordMessage {
  id?: string;
  shortId?: string;
  type?: string;
  publishDateFrom?: number;
  publishDateTo?: number;
  followUpDate?: number;
  areas?: Array<{ descs?: NiordDesc[] }>;
  descs?: NiordDesc[];
  parts?: Array<{
    descs?: NiordDesc[];
    geometry?: {
      features?: Array<{ geometry?: Geometry }>;
    };
  }>;
}

function pickEnglishDesc(descs: NiordDesc[] | undefined): NiordDesc | undefined {
  if (!Array.isArray(descs) || descs.length === 0) return undefined;
  return descs.find((d) => d.lang === "en") ?? descs[0];
}

async function fetchDmaNiordWarnings(nowSec: number): Promise<HazardFeature[]> {
  const url = "https://niord.dma.dk/rest/public/v1/messages?domain=niord-nw";
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    console.warn(`[ngaMaritime] DMA Niord HTTP ${res.status}`);
    return [];
  }

  const items = (await res.json()) as NiordMessage[];
  if (!Array.isArray(items)) return [];

  const results: HazardFeature[] = [];

  for (const msg of items) {
    const shortId = (msg.shortId || msg.id || "").trim();
    if (!shortId) continue;

    const geoms: Geometry[] = [];
    const textChunks: string[] = [];

    const topDesc = pickEnglishDesc(msg.descs);
    if (topDesc?.title) textChunks.push(topDesc.title);

    for (const part of msg.parts ?? []) {
      const pDesc = pickEnglishDesc(part.descs);
      if (pDesc?.subject) textChunks.push(pDesc.subject);
      if (pDesc?.details) textChunks.push(stripHtmlTags(pDesc.details));
      for (const feat of part.geometry?.features ?? []) {
        if (feat.geometry) geoms.push(feat.geometry);
      }
    }

    if (geoms.length === 0) continue;

    const areaDesc = pickEnglishDesc(msg.areas?.[0]?.descs);
    const areaName = areaDesc?.name || "Baltic / North Sea";
    const rawText = textChunks.filter(Boolean).join("\n\n") || shortId;
    const headline =
      topDesc?.title ||
      pickEnglishDesc(msg.parts?.[0]?.descs)?.subject ||
      areaName;

    const issuedAt = msg.publishDateFrom
      ? Math.floor(msg.publishDateFrom / 1000)
      : nowSec;
    const validTo = msg.publishDateTo
      ? Math.floor(msg.publishDateTo / 1000)
      : msg.followUpDate
      ? Math.floor(msg.followUpDate / 1000)
      : nowSec + 7 * 86400;

    const subType: HazardSubType =
      msg.type === "NAVAREA_WARNING" || msg.type === "SUBAREA_WARNING"
        ? "NAVAREA"
        : "NAVTEX";

    geoms.forEach((geom, idx) => {
      const suffix = idx === 0 ? "" : `-${idx + 1}`;
      results.push(
        buildFeature({
          id: `DMA-${shortId.replace(/[^A-Za-z0-9-]/g, "-")}${suffix}`,
          subType,
          severity: DANGER_REGEX.test(rawText) ? "danger" : "warning",
          title: `${shortId} — ${headline}`,
          rawText: `${shortId} (${areaName})\n\n${rawText}`,
          stationOrArea: areaName,
          issuer: "DMA Denmark",
          country: "Denmark",
          region: "Europe",
          geometry: geom,
          issuedAt,
          validFrom: issuedAt,
          validTo: validTo > issuedAt ? validTo : nowSec + 7 * 86400,
        })
      );
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 4. Greece HNHS — Hellenic Navy Hydrographic Service (NAVAREA III / Aegean / Med)
// ---------------------------------------------------------------------------
interface HnhsPointItem {
  id?: number | string;
  title?: string;
  description?: string;
  start?: string | null;
  end?: string | null;
  coordinates?: string[];
  is_circle?: boolean;
}

async function fetchHnhsGreeceWarnings(
  nowSec: number
): Promise<HazardFeature[]> {
  const pageUrl = "https://pn.valmore.gr/?lang=eng&type=4";
  const getRes = await fetch(pageUrl, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!getRes.ok) {
    console.warn(`[ngaMaritime] HNHS page HTTP ${getRes.status}`);
    return [];
  }

  const rawSetCookies =
    typeof getRes.headers.getSetCookie === "function"
      ? getRes.headers.getSetCookie()
      : [getRes.headers.get("set-cookie") ?? ""];
  const cookieHeader = rawSetCookies
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");

  const html = await getRes.text();
  const csrfToken = /"X-CSRF-TOKEN":\s*"([^"]+)"/.exec(html)?.[1] ?? "";

  const postRes = await fetch("https://pn.valmore.gr/view-points", {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(csrfToken ? { "X-CSRF-TOKEN": csrfToken } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({ type: "4", lang: "eng" }),
    signal: AbortSignal.timeout(15000),
  });

  if (!postRes.ok) {
    console.warn(`[ngaMaritime] HNHS view-points HTTP ${postRes.status}`);
    return [];
  }

  const payload = (await postRes.json()) as { points?: HnhsPointItem[] };
  const results: HazardFeature[] = [];

  for (const item of payload.points ?? []) {
    const titleRaw = String(item.title ?? "").trim();
    const descRaw = String(item.description ?? "").trim();
    if (!descRaw && !titleRaw) continue;

    const coordSource =
      Array.isArray(item.coordinates) && item.coordinates.length > 0
        ? item.coordinates.join("\n")
        : `${titleRaw}\n${descRaw}`;

    const coords = parseNgaCoordinates(coordSource);
    if (coords.length === 0) continue;

    let geometry: Geometry | null = null;
    const radiusMatch = /RADIUS\s+(?:OF\s+)?([\d.]+)\s*(?:NM|NAUTICAL)/i.exec(
      descRaw
    );
    if ((item.is_circle || radiusMatch) && coords.length === 1) {
      const rNm = radiusMatch ? Math.min(parseFloat(radiusMatch[1]), 100) : 2;
      geometry = createNmCircleGeometry(coords[0][0], coords[0][1], rNm);
    } else {
      geometry = coordsToGeoJsonGeometry(coords);
    }
    if (!geometry) continue;

    const startMs = item.start ? Date.parse(item.start) : NaN;
    const endMs = item.end ? Date.parse(item.end) : NaN;
    const issuedAt = !Number.isNaN(startMs)
      ? Math.floor(startMs / 1000)
      : parseMaritimeIssueDate(titleRaw, nowSec);
    const validFrom = Math.min(issuedAt, nowSec);
    const validTo =
      !Number.isNaN(endMs) && Math.floor(endMs / 1000) > nowSec
        ? Math.floor(endMs / 1000)
        : nowSec + 7 * 86400;

    const navwarnRef =
      /\b([A-Z]{2}\d{2})\b/.exec(titleRaw)?.[1] ||
      /\b(\d{1,4}\/\d{2})\b/.exec(titleRaw)?.[1] ||
      String(item.id ?? results.length + 1);

    const firstDescLine =
      descRaw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 2 && l !== "ZCZC") ?? "Mediterranean NAVWARN";

    results.push(
      buildFeature({
        id: `HNHS-NAVTEX-${String(item.id ?? navwarnRef).replace(/[^A-Za-z0-9-]/g, "-")}`,
        subType: "NAVTEX",
        severity: DANGER_REGEX.test(`${titleRaw} ${descRaw}`)
          ? "danger"
          : "warning",
        title: `HNHS ${navwarnRef} — ${firstDescLine}`,
        rawText: `${titleRaw}\n\n${descRaw}`.trim(),
        stationOrArea: "NAVAREA III",
        issuer: "HNHS Greece",
        country: "Greece",
        region: "Europe",
        geometry,
        issuedAt,
        validFrom,
        validTo,
      })
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// 5. Japan Coast Guard JHOD — NAVAREA XI & NW Pacific English NAVTEX
// ---------------------------------------------------------------------------
async function fetchJcgSeries(
  nowSec: number,
  jcgType: "NAVAREA11" | "NAVTEX"
): Promise<HazardFeature[]> {
  const currentYear = new Date(nowSec * 1000).getUTCFullYear();
  const listRes = await fetch(
    "https://www1.kaiho.mlit.go.jp/TUHO/keiho/cgi/warnings.cgi",
    {
      method: "POST",
      headers: {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: `YEAR=${currentYear}&TYPE=${jcgType}&LANG=EG`,
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!listRes.ok) return [];

  const xml = await listRes.text();
  const tanas = [...xml.matchAll(/<tana>([^<]+)<\/tana>/g)].map((m) =>
    m[1].trim()
  );
  if (tanas.length === 0) return [];

  const dispRes = await fetch(
    "https://www1.kaiho.mlit.go.jp/TUHO/keiho/cgi/disp_warnings.cgi",
    {
      method: "POST",
      headers: {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: `TYPE=${jcgType}&TANA=${encodeURIComponent(
        `${tanas.slice(0, 60).join(":")}:`
      )}&LANG=EG`,
      signal: AbortSignal.timeout(20000),
    }
  );
  if (!dispRes.ok) return [];

  const html = await dispRes.text();
  const chunks = html.split(/<hr\s*\/?>/i);
  const results: HazardFeature[] = [];

  for (const chunk of chunks) {
    const headerMatch =
      /<STRONG>\s*NO\.([A-Za-z0-9-]+)\s+Date:([^\r\n<]+)\s*<\/STRONG>/i.exec(
        chunk
      );
    if (!headerMatch) continue;

    const msgNo = headerMatch[1].trim();
    const dateStr = headerMatch[2].trim();
    const bodyText = stripHtmlTags(
      chunk.slice(headerMatch.index + headerMatch[0].length)
    );

    if (!bodyText || /WARNING\s+MESSAGES\s+IN\s+FORCE/i.test(bodyText)) {
      continue;
    }

    const ddmOrDms = parseNgaCoordinates(bodyText);
    const coords =
      ddmOrDms.length > 0 ? ddmOrDms : parseCompactMarineCoords(bodyText);
    const geometry = coordsToGeoJsonGeometry(coords);
    if (!geometry) continue;

    const issuedAt = parseMaritimeIssueDate(dateStr, nowSec);
    const cancelSec = parseNgaCancelTimestamp(bodyText, currentYear);
    const validTo =
      cancelSec && cancelSec > issuedAt ? cancelSec : nowSec + 7 * 86400;

    const summaryLines = bodyText
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/\.$/, ""))
      .filter(Boolean);
    const summary = summaryLines.slice(0, 2).join(" — ") || msgNo;

    const isNavarea = jcgType === "NAVAREA11";

    results.push(
      buildFeature({
        id: `JCG-${jcgType}-${msgNo}`,
        subType: isNavarea ? "NAVAREA" : "NAVTEX",
        severity: DANGER_REGEX.test(bodyText) ? "danger" : "warning",
        title: `${isNavarea ? "NAVAREA XI" : "JCG NAVTEX"} ${msgNo} — ${summary}`,
        rawText: `NO.${msgNo} (${dateStr})\n\n${bodyText}`,
        stationOrArea: isNavarea ? "NAVAREA XI" : "JP-NAVTEX",
        issuer: "JCG Japan",
        country: "Japan / NW Pacific",
        region: "Asia",
        geometry,
        issuedAt,
        validFrom: issuedAt,
        validTo,
      })
    );
  }

  return results;
}

async function fetchJcgJapanWarnings(nowSec: number): Promise<HazardFeature[]> {
  const [navarea11, navtex] = await Promise.all([
    fetchJcgSeries(nowSec, "NAVAREA11"),
    fetchJcgSeries(nowSec, "NAVTEX"),
  ]);
  return [...navarea11, ...navtex];
}

// ---------------------------------------------------------------------------
// 6. Global WMO / GTS High Seas & Regional Marine Bulletins (All Ocean Basins)
// ---------------------------------------------------------------------------
interface WmoMarineSource {
  navArea: string;
  idPrefix: string;
  issuer: string;
  country: string;
  region: HazardRegion;
  url: string;
  allowBoundaryFallback?: boolean;
}

const WMO_GLOBAL_MARINE_SOURCES: WmoMarineSource[] = [
  // North & Tropical Atlantic / East & Central Pacific (NOAA OPC / NHC)
  {
    navArea: "IV",
    idPrefix: "WMO-NAVAREA-IV-AT1",
    issuer: "NOAA OPC (US)",
    country: "North Atlantic",
    region: "North America",
    url: "https://tgftp.nws.noaa.gov/data/raw/fz/fznt01.kwbc.hsf.at1.txt",
  },
  {
    navArea: "IV",
    idPrefix: "WMO-NAVAREA-IV-AT2",
    issuer: "NOAA NHC (US)",
    country: "Tropical Atlantic & Caribbean",
    region: "North America",
    url: "https://tgftp.nws.noaa.gov/data/raw/fz/fznt02.knhc.hsf.at2.txt",
  },
  {
    navArea: "XII",
    idPrefix: "WMO-NAVAREA-XII-EP1",
    issuer: "NOAA OPC (US)",
    country: "NE Pacific",
    region: "North America",
    url: "https://tgftp.nws.noaa.gov/data/raw/fz/fzpn01.kwbc.hsf.ep1.txt",
  },
  {
    navArea: "XII",
    idPrefix: "WMO-NAVAREA-XII-EP2",
    issuer: "NOAA NHC (US)",
    country: "East Tropical Pacific",
    region: "North America",
    url: "https://tgftp.nws.noaa.gov/data/raw/fz/fzpn02.knhc.hsf.ep2.txt",
  },
  // South Atlantic: Brazil Navy DHN (NAVAREA V) & Argentina SHN/SMN (NAVAREA VI)
  {
    navArea: "V",
    idPrefix: "WMO-NAVAREA-V-BR1",
    issuer: "DHN Brazil",
    country: "Brazil / SW Atlantic",
    region: "South America",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwst01.sbbr..txt",
    allowBoundaryFallback: true,
  },
  {
    navArea: "V",
    idPrefix: "WMO-NAVAREA-V-BR2",
    issuer: "DHN Brazil",
    country: "Brazil / SW Atlantic",
    region: "South America",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwst02.sbbr..txt",
  },
  {
    navArea: "VI",
    idPrefix: "WMO-NAVAREA-VI-AR1",
    issuer: "SHN / SMN Argentina",
    country: "Argentina / South Atlantic",
    region: "South America",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwst01.sabm..txt",
    allowBoundaryFallback: true,
  },
  {
    navArea: "VI",
    idPrefix: "WMO-NAVAREA-VI-AA1",
    issuer: "SMN Argentina",
    country: "Antarctic Peninsula / Drake Passage",
    region: "High Seas",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwaa01.sawb..txt",
  },
  // SE Pacific: Chile DIRECTEMAR (NAVAREA XV)
  {
    navArea: "XV",
    idPrefix: "WMO-NAVAREA-XV-CL1",
    issuer: "DIRECTEMAR Chile",
    country: "Chile / SE Pacific",
    region: "South America",
    url: "https://tgftp.nws.noaa.gov/data/raw/fz/fzps01.scsc..txt",
    allowBoundaryFallback: true,
  },
  // Oceania & South Pacific: BoM Australia (NAVAREA X), MetService NZ (NAVAREA XIV), Fiji FMS, New Caledonia
  {
    navArea: "X",
    idPrefix: "WMO-NAVAREA-X-AU1",
    issuer: "BoM Australia",
    country: "Coral Sea / Australia",
    region: "Oceania",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwps22.abrf..txt",
  },
  {
    navArea: "X",
    idPrefix: "WMO-NAVAREA-X-AU2",
    issuer: "BoM Australia",
    country: "Southern Ocean / Australia",
    region: "Oceania",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwso21.abrf..txt",
    allowBoundaryFallback: true,
  },
  {
    navArea: "XIV",
    idPrefix: "WMO-NAVAREA-XIV-NZ1",
    issuer: "MetService NZ",
    country: "New Zealand / South Pacific",
    region: "Oceania",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwnz40.nzkl..txt",
    allowBoundaryFallback: true,
  },
  {
    navArea: "XIV",
    idPrefix: "WMO-NAVAREA-XIV-FJ1",
    issuer: "FMS Fiji",
    country: "Fiji / Tropical South Pacific",
    region: "Oceania",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwps21.nffn..txt",
  },
  {
    navArea: "XIV",
    idPrefix: "WMO-NAVAREA-XIV-NC1",
    issuer: "Météo-France NC",
    country: "New Caledonia",
    region: "Oceania",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwnc01.nwbb..txt",
  },
  // NW Pacific Marine Gale/Typhoon Bulletins: JMA Japan (NAVAREA XI)
  {
    navArea: "XI",
    idPrefix: "WMO-NAVAREA-XI-25",
    issuer: "JMA Japan",
    country: "NW Pacific",
    region: "Asia",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwjp25.rjtd..txt",
  },
  {
    navArea: "XI",
    idPrefix: "WMO-NAVAREA-XI-26",
    issuer: "JMA Japan",
    country: "NW Pacific",
    region: "Asia",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwjp26.rjtd..txt",
  },
  {
    navArea: "XI",
    idPrefix: "WMO-NAVAREA-XI-27",
    issuer: "JMA Japan",
    country: "East China & Philippine Sea",
    region: "Asia",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwjp27.rjtd..txt",
  },
  {
    navArea: "XI",
    idPrefix: "WMO-NAVAREA-XI-28",
    issuer: "JMA Japan",
    country: "Sea of Okhotsk & Bering Sea",
    region: "Asia",
    url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwjp28.rjtd..txt",
  },
];

const NAMED_SEA_CENTERS: Array<{ pattern: RegExp; lon: number; lat: number; radiusNm: number }> = [
  { pattern: /\bEAST\s+CHINA\s+SEA\b/i, lon: 125.5, lat: 29.0, radiusNm: 140 },
  { pattern: /\bSOUTH\s+CHINA\s+SEA\b/i, lon: 114.5, lat: 14.5, radiusNm: 160 },
  { pattern: /\bYELLOW\s+SEA\b/i, lon: 123.5, lat: 35.5, radiusNm: 110 },
  { pattern: /\bSEA\s+OF\s+JAPAN\b/i, lon: 135.0, lat: 39.5, radiusNm: 140 },
  { pattern: /\bSEA\s+OF\s+OKHOTSK\b/i, lon: 149.0, lat: 52.0, radiusNm: 160 },
  { pattern: /\bBERING\s+SEA\b/i, lon: 175.0, lat: 57.5, radiusNm: 170 },
  { pattern: /\bPHILIPPINE\s+SEA\b/i, lon: 132.0, lat: 19.0, radiusNm: 160 },
  { pattern: /\bCORAL\s+SEA\b/i, lon: 153.5, lat: -18.5, radiusNm: 150 },
  { pattern: /\bTASMAN\s+SEA\b/i, lon: 160.0, lat: -38.0, radiusNm: 150 },
  { pattern: /\bBASS\s+STRAIT\b/i, lon: 146.0, lat: -39.5, radiusNm: 90 },
  { pattern: /\bCOOK\s+STRAIT\b/i, lon: 174.5, lat: -41.3, radiusNm: 65 },
  { pattern: /\bDRAKE\s+PASSAGE\b/i, lon: -65.0, lat: -58.5, radiusNm: 140 },
  { pattern: /\bRIO\s+DE\s+LA\s+PLATA\b/i, lon: -56.0, lat: -35.5, radiusNm: 95 },
  { pattern: /\bDAVIS\s+STRAIT\b/i, lon: -57.5, lat: 64.0, radiusNm: 130 },
  { pattern: /\bDENMARK\s+STRAIT\b/i, lon: -27.5, lat: 66.5, radiusNm: 120 },
  { pattern: /\bCARIBBEAN\s+SEA\b/i, lon: -74.0, lat: 15.5, radiusNm: 150 },
  { pattern: /\bGULF\s+OF\s+MEXICO\b/i, lon: -90.0, lat: 25.0, radiusNm: 140 },
];

const NAVAREA_REPRESENTATIVE_POINTS: Record<string, [number, number]> = {
  IV: [-58.0, 36.0],
  V: [-39.5, -22.5],
  VI: [-57.5, -41.5],
  X: [152.5, -33.5],
  XI: [137.0, 29.0],
  XII: [-135.0, 37.0],
  XIV: [176.5, -39.5],
  XV: [-74.0, -37.0],
};

function resolveMarineFallbackGeometry(
  text: string,
  navArea: string,
  allowPointFallback: boolean
): Geometry | null {
  for (const sea of NAMED_SEA_CENTERS) {
    if (sea.pattern.test(text)) {
      return createNmCircleGeometry(sea.lon, sea.lat, sea.radiusNm);
    }
  }
  if (!allowPointFallback) return null;
  const pt = NAVAREA_REPRESENTATIVE_POINTS[navArea];
  return pt ? { type: "Point", coordinates: pt } : null;
}

function isStaleBulletin(text: string, currentYear: number): boolean {
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) =>
    parseInt(m[1], 10)
  );
  if (years.length === 0) return false;
  const maxYear = Math.max(...years);
  return maxYear < currentYear - 1;
}

async function fetchGlobalWmoMarineBulletins(
  nowSec: number
): Promise<HazardFeature[]> {
  const currentYear = new Date(nowSec * 1000).getUTCFullYear();
  const features: HazardFeature[] = [];

  const settled = await Promise.allSettled(
    WMO_GLOBAL_MARINE_SOURCES.map(async (src) => {
      const res = await fetch(src.url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      const rawBulletin = (await res.text()).trim();
      if (!rawBulletin) return [];

      if (isStaleBulletin(rawBulletin, currentYear)) return [];
      if (/\b(?:NO\s+WARNINGS?|NO\s+GALE|WARNINGS?\s*:\s*NIL|\bNIL\b)\b/i.test(rawBulletin) && !/\b(?:GALE|STORM|HURRICANE|TYPHOON|CYCLONE)\s+WARNING\b/i.test(rawBulletin)) {
        return [];
      }

      const localFeatures: HazardFeature[] = [];

      // Case A: NOAA High Seas Forecast "...WARNING..." blocks
      if (rawBulletin.includes(".WARNINGS.")) {
        const warnSection =
          rawBulletin.split(".WARNINGS.")[1]?.split(".SYNOPSIS")[0] ?? "";
        const blocks = warnSection
          .split(/\.\.\.([A-Z\s/]+WARNING)\.\.\./g)
          .slice(1);
        for (let i = 0; i < blocks.length; i += 2) {
          const heading = (blocks[i] ?? "MARITIME WARNING").trim();
          const body = (blocks[i + 1] ?? "").trim();
          if (!body) continue;

          const firstPara = body.split(/\n\.24 HOUR FORECAST/i)[0] ?? body;
          const ddmCoords = parseNgaCoordinates(firstPara);
          const compactCoords =
            ddmCoords.length > 0 ? ddmCoords : parseCompactMarineCoords(firstPara);

          let geometry: Geometry | null = null;
          const radiusMatch = /WITHIN\s+(\d{2,4})\s*NM/i.exec(firstPara);
          if (compactCoords.length === 1 && radiusMatch) {
            const rNm = Math.min(parseInt(radiusMatch[1], 10), 400);
            geometry = createNmCircleGeometry(
              compactCoords[0][0],
              compactCoords[0][1],
              rNm
            );
          } else {
            geometry =
              coordsToGeoJsonGeometry(compactCoords) ??
              resolveMarineFallbackGeometry(firstPara, src.navArea, false);
          }
          if (!geometry) continue;

          const blockIdx = Math.floor(i / 2) + 1;
          localFeatures.push(
            buildFeature({
              id: `${src.idPrefix}-${blockIdx}`,
              subType: "NAVAREA",
              severity: DANGER_REGEX.test(`${heading} ${body}`)
                ? "danger"
                : "warning",
              title: `NAVAREA ${src.navArea} — ${heading} #${blockIdx}`,
              rawText: `${heading}\n${body}`,
              stationOrArea: `NAVAREA ${src.navArea}`,
              issuer: src.issuer,
              country: src.country,
              region: src.region,
              geometry,
              issuedAt: nowSec,
              validFrom: nowSec - 3600,
              validTo: nowSec + 36 * 3600,
            })
          );
        }
        return localFeatures;
      }

      // Case B: Brazilian Navy DHN "WARNING NR XXX/YYYY" blocks
      if (/WARNING\s+NR\s+\d+\/\d{4}/i.test(rawBulletin)) {
        const blocks = rawBulletin.split(/(?=WARNING\s+NR\s+\d+\/\d{4})/i);
        for (const blk of blocks) {
          const nrMatch = /WARNING\s+NR\s+(\d+\/\d{4})/i.exec(blk);
          if (!nrMatch) continue;
          const coords = parseCompactMarineCoords(blk);
          const geometry =
            coordsToGeoJsonGeometry(coords) ??
            resolveMarineFallbackGeometry(
              blk,
              src.navArea,
              Boolean(src.allowBoundaryFallback)
            );
          if (!geometry) continue;

          const lines = blk
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          const subTitle = lines[1] || "MARINE WARNING";

          localFeatures.push(
            buildFeature({
              id: `${src.idPrefix}-${nrMatch[1].replace("/", "-")}`,
              subType: "NAVAREA",
              severity: DANGER_REGEX.test(blk) ? "danger" : "warning",
              title: `NAVAREA ${src.navArea} — ${subTitle} (${nrMatch[1]})`,
              rawText: blk.trim(),
              stationOrArea: `NAVAREA ${src.navArea}`,
              issuer: src.issuer,
              country: src.country,
              region: src.region,
              geometry,
              issuedAt: nowSec,
              validFrom: nowSec - 3600,
              validTo: nowSec + 36 * 3600,
            })
          );
        }
        return localFeatures;
      }

      // Case C: JMA / MetService NZ / BoM / DIRECTEMAR / SMN marine warning segments
      const segments = rawBulletin.split(
        /\n(?=(?:HURRICANE|TYPHOON|CYCLONE|STORM|GALE)\s+WARNING|WARNING\.)/i
      );
      let segNum = 0;
      for (const seg of segments) {
        if (
          !/\b(WARNING|CYCLONE|TYPHOON|GALE|VERY\s+ROUGH)\b/i.test(seg) ||
          /^WW[A-Z]{2}\d+\s+[A-Z]{4}\s+\d+$/i.test(seg.trim())
        ) {
          continue;
        }
        const cleanSeg = seg.split(/\nSUMMARY\./i)[0]?.trim() ?? "";
        if (!cleanSeg) continue;

        const ddmCoords = parseNgaCoordinates(cleanSeg);
        const coords =
          ddmCoords.length > 0 ? ddmCoords : parseCompactMarineCoords(cleanSeg);

        let geometry: Geometry | null = null;
        const radMatch = /within\s+(\d{1,4})\s*(?:nautical\s+)?miles/i.exec(cleanSeg);
        const hasSynopticFronts = /\b(?:OCCLUDED|WARM|COLD|STATIONARY)\s+FRONT\s+FROM\b/i.test(
          cleanSeg
        );
        if (coords.length >= 1 && (radMatch || hasSynopticFronts)) {
          const rNm = radMatch
            ? Math.min(parseInt(radMatch[1], 10), 250)
            : 200;
          geometry = createNmCircleGeometry(coords[0][0], coords[0][1], rNm);
        } else {
          geometry = coordsToGeoJsonGeometry(coords);
        }

        if (!geometry) {
          geometry = resolveMarineFallbackGeometry(
            cleanSeg,
            src.navArea,
            Boolean(src.allowBoundaryFallback)
          );
        }
        if (!geometry) continue;

        segNum++;
        const firstLine =
          cleanSeg
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length > 3 && !/^(?:WW|FZ)[A-Z0-9\s]+$/.test(l))
            ?.replace(/\.$/, "") || "MARITIME WARNING";

        localFeatures.push(
          buildFeature({
            id: `${src.idPrefix}-${segNum}`,
            subType: "NAVAREA",
            severity: DANGER_REGEX.test(cleanSeg) ? "danger" : "warning",
            title: `NAVAREA ${src.navArea} — ${firstLine}`,
            rawText: cleanSeg.slice(0, 4000),
            stationOrArea: `NAVAREA ${src.navArea}`,
            issuer: src.issuer,
            country: src.country,
            region: src.region,
            geometry,
            issuedAt: nowSec,
            validFrom: nowSec - 3600,
            validTo: nowSec + 24 * 3600,
          })
        );
      }

      return localFeatures;
    })
  );

  for (const res of settled) {
    if (res.status === "fulfilled") {
      features.push(...res.value);
    }
  }

  return features;
}

// ---------------------------------------------------------------------------
// Unified Global Maritime Aggregator
// ---------------------------------------------------------------------------
export async function fetchNgaMaritimeHazards(
  nowSec: number
): Promise<HazardFeature[]> {
  const boundaries = await loadNavAreaBoundaries();

  const sourceNames = [
    "NGA MSI",
    "UKHO Admiralty",
    "DMA Niord",
    "HNHS Greece",
    "JCG Japan",
    "WMO Global Marine",
  ];

  const settled = await Promise.allSettled([
    fetchNgaMsiBroadcasts(nowSec, boundaries),
    fetchUkhoAdmiraltyWarnings(nowSec),
    fetchDmaNiordWarnings(nowSec),
    fetchHnhsGreeceWarnings(nowSec),
    fetchJcgJapanWarnings(nowSec),
    fetchGlobalWmoMarineBulletins(nowSec),
  ]);

  const combined: HazardFeature[] = [];
  const countsReport: string[] = [];

  settled.forEach((res, idx) => {
    const label = sourceNames[idx];
    if (res.status === "fulfilled") {
      combined.push(...res.value);
      countsReport.push(`${label}=${res.value.length}`);
    } else {
      console.warn(
        `[ngaMaritime] ${label} source failed:`,
        res.reason instanceof Error ? res.reason.message : res.reason
      );
      countsReport.push(`${label}=ERR`);
    }
  });

  console.log(
    `[ngaMaritime] Aggregated ${combined.length} global maritime warnings (${countsReport.join(
      ", "
    )})`
  );
  return combined;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
