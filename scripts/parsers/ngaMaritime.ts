import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FeatureCollection, Geometry } from "geojson";
import type { HazardFeature, HazardSeverity } from "../../src/types/schema.ts";
import {
  coordsToGeoJsonGeometry,
  createNmCircleGeometry,
  parseNgaCancelTimestamp,
  parseNgaCoordinates,
} from "../utils/geometry.ts";

const USER_AGENT = "GlobalHazardTracker/1.0 (+https://github.com)";
const FETCH_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json, text/plain, */*",
};

const DANGER_REGEX =
  /HAZARDOUS|ROCKET|MISSILE|GUNNERY|MINE|DERELICT|PIRACY|TSUNAMI|UNEXPLODED|HURRICANE|STORM\s+WARNING|TYPHOON/i;

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

function parseNgaIssueDate(raw: unknown, fallbackSec: number): number {
  if (!raw) return fallbackSec;
  const str = String(raw).trim();
  if (!str) return fallbackSec;

  // Format: DDHHMMZ MON YYYY or DDHHMMZ MON YY (e.g. "071420Z NOV 2026" or "071420Z NOV 26")
  const milMatch =
    /(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{2,4})/i.exec(str);
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

  // Format: MM/DD/YYYY or ISO
  const parsedMs = Date.parse(str);
  if (!Number.isNaN(parsedMs)) {
    return Math.floor(parsedMs / 1000);
  }

  return fallbackSec;
}

interface NgaBroadcastWarning {
  msgYear?: number | string;
  msgNumber?: number | string;
  navArea?: string;
  subregion?: string;
  text?: string;
  status?: string;
  issueDate?: string;
  authority?: string;
}

function parseCompactMarineCoords(text: string): [number, number][] {
  // Matches WMO High Seas / NAVTEX compact degrees like "57N 169E", "38N28W", "54.5N 152.0E"
  const regex =
    /\b(\d{1,2}(?:\.\d+)?)\s*([NS])\s*(\d{1,3}(?:\.\d+)?)\s*([EW])\b/gi;
  const coords: [number, number][] = [];
  let m: RegExpExecArray | null;
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

async function fetchWmoNavareaFallback(
  nowSec: number,
  boundaries: Map<string, Geometry>
): Promise<HazardFeature[]> {
  const sources = [
    {
      navArea: "IV",
      idPrefix: "WMO-NAVAREA-IV-AT1",
      url: "https://tgftp.nws.noaa.gov/data/raw/fz/fznt01.kwbc.hsf.at1.txt",
    },
    {
      navArea: "IV",
      idPrefix: "WMO-NAVAREA-IV-AT2",
      url: "https://tgftp.nws.noaa.gov/data/raw/fz/fznt02.knhc.hsf.at2.txt",
    },
    {
      navArea: "XII",
      idPrefix: "WMO-NAVAREA-XII-EP1",
      url: "https://tgftp.nws.noaa.gov/data/raw/fz/fzpn01.kwbc.hsf.ep1.txt",
    },
    {
      navArea: "XI",
      idPrefix: "WMO-NAVAREA-XI-25",
      url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwjp25.rjtd..txt",
    },
    {
      navArea: "XI",
      idPrefix: "WMO-NAVAREA-XI-26",
      url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwjp26.rjtd..txt",
    },
    {
      navArea: "XI",
      idPrefix: "WMO-NAVAREA-XI-27",
      url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwjp27.rjtd..txt",
    },
    {
      navArea: "XI",
      idPrefix: "WMO-NAVAREA-XI-28",
      url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwjp28.rjtd..txt",
    },
    {
      navArea: "VI",
      idPrefix: "WMO-NAVAREA-VI-01",
      url: "https://tgftp.nws.noaa.gov/data/raw/ww/wwst01.sabm..txt",
    },
  ];

  const features: HazardFeature[] = [];

  const settled = await Promise.allSettled(
    sources.map(async (src) => {
      const res = await fetch(src.url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return [];
      const rawBulletin = (await res.text()).trim();
      if (!rawBulletin) return [];

      const localFeatures: HazardFeature[] = [];

      // Split High Seas "...WARNING..." sections or RJTD "WARNING." / "GALE WARNING." blocks
      if (rawBulletin.includes(".WARNINGS.")) {
        const warnSection =
          rawBulletin.split(".WARNINGS.")[1]?.split(".SYNOPSIS")[0] ?? "";
        const blocks = warnSection
          .split(/\.\.\.([A-Z\s]+WARNING)\.\.\./g)
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
            const rNm = Math.min(parseInt(radiusMatch[1], 10), 450);
            geometry = createNmCircleGeometry(
              compactCoords[0][0],
              compactCoords[0][1],
              rNm
            );
          } else {
            geometry = coordsToGeoJsonGeometry(compactCoords);
          }
          if (!geometry) {
            geometry = boundaries.get(src.navArea) ?? null;
          }
          if (!geometry) continue;

          const blockIdx = Math.floor(i / 2) + 1;
          const severity: HazardSeverity = DANGER_REGEX.test(
            `${heading} ${body}`
          )
            ? "danger"
            : "warning";

          localFeatures.push({
            type: "Feature",
            geometry,
            properties: {
              id: `${src.idPrefix}-${blockIdx}`,
              domain: "maritime",
              subType: "NAVAREA",
              severity,
              title: `NAVAREA ${src.navArea} ${heading} #${blockIdx}`,
              rawText: `${heading}\n${body}`,
              stationOrArea: src.navArea,
              issuedAt: nowSec,
              validFrom: nowSec - 3600,
              validTo: nowSec + 48 * 3600,
            },
          });
        }
      } else {
        // Parse WMO WW marine warning blocks (e.g., RJTD / SABM)
        const segments = rawBulletin.split(
          /\n(?=(?:HURRICANE|TYPHOON|STORM|GALE)\s+WARNING\.|WARNING\.)/i
        );
        let segNum = 0;
        for (const seg of segments) {
          if (!/WARNING/i.test(seg) || /^WW[A-Z]{2}\d+/i.test(seg.trim())) {
            continue;
          }
          const cleanSeg = seg.split(/\nSUMMARY\./i)[0]?.trim() ?? "";
          if (!cleanSeg) continue;
          segNum++;

          const ddmCoords = parseNgaCoordinates(cleanSeg);
          const coords =
            ddmCoords.length > 0 ? ddmCoords : parseCompactMarineCoords(cleanSeg);
          let geometry = coordsToGeoJsonGeometry(coords);
          if (!geometry) {
            geometry = boundaries.get(src.navArea) ?? null;
          }
          if (!geometry) continue;

          const firstLine =
            cleanSeg.split(/\r?\n/)[0]?.replace(/\.$/, "").trim() ||
            "NAVIGATIONAL WARNING";
          const severity: HazardSeverity = DANGER_REGEX.test(cleanSeg)
            ? "danger"
            : "warning";

          localFeatures.push({
            type: "Feature",
            geometry,
            properties: {
              id: `${src.idPrefix}-${segNum}`,
              domain: "maritime",
              subType: "NAVAREA",
              severity,
              title: `NAVAREA ${src.navArea} ${firstLine} #${segNum}`,
              rawText: cleanSeg,
              stationOrArea: src.navArea,
              issuedAt: nowSec,
              validFrom: nowSec - 3600,
              validTo: nowSec + 24 * 3600,
            },
          });
        }

        if (localFeatures.length === 0) {
          const fallbackGeom = boundaries.get(src.navArea);
          if (fallbackGeom) {
            localFeatures.push({
              type: "Feature",
              geometry: fallbackGeom,
              properties: {
                id: `${src.idPrefix}-BULLETIN`,
                domain: "maritime",
                subType: "NAVAREA",
                severity: DANGER_REGEX.test(rawBulletin) ? "danger" : "warning",
                title: `NAVAREA ${src.navArea} Maritime Warning Bulletin`,
                rawText: rawBulletin.slice(0, 4000),
                stationOrArea: src.navArea,
                issuedAt: nowSec,
                validFrom: nowSec - 3600,
                validTo: nowSec + 24 * 3600,
              },
            });
          }
        }
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

export async function fetchNgaMaritimeHazards(
  nowSec: number
): Promise<HazardFeature[]> {
  const boundaries = await loadNavAreaBoundaries();
  const url =
    "https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=active";

  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      console.warn(
        `[ngaMaritime] NGA MSI API returned HTTP ${res.status}; using WMO NAVAREA/METAREA high-seas mirror fallback.`
      );
      const fallback = await fetchWmoNavareaFallback(nowSec, boundaries);
      console.log(
        `[ngaMaritime] Parsed ${fallback.length} WMO maritime NAVAREA warnings`
      );
      return fallback;
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
      if (!rawText) continue;

      const navArea = normalizeNavAreaCode(w.navArea || "IV");
      const msgYear = String(w.msgYear ?? new Date(nowSec * 1000).getUTCFullYear());
      const msgNumber = String(w.msgNumber ?? Math.abs(hashCode(rawText)));

      const issuedAt = parseNgaIssueDate(w.issueDate, nowSec);
      const validFrom = issuedAt;
      const cancelSec = parseNgaCancelTimestamp(rawText);
      const validTo =
        cancelSec && cancelSec > validFrom ? cancelSec : nowSec + 7 * 86400;

      const severity: HazardSeverity = DANGER_REGEX.test(rawText)
        ? "danger"
        : "warning";

      const coords = parseNgaCoordinates(rawText);
      let geometry = coordsToGeoJsonGeometry(coords);
      if (!geometry) {
        geometry = boundaries.get(navArea) ?? null;
      }
      if (!geometry) continue;

      const id = `NGA-NAVAREA-${navArea}-${msgYear}-${msgNumber}`;
      const title = `NAVAREA ${navArea} Warning ${msgNumber}/${msgYear}`;

      results.push({
        type: "Feature",
        geometry,
        properties: {
          id,
          domain: "maritime",
          subType: "NAVAREA",
          severity,
          title,
          rawText,
          stationOrArea: navArea,
          issuedAt,
          validFrom,
          validTo,
        },
      });
    }

    console.log(
      `[ngaMaritime] Parsed ${results.length} NGA MSI broadcast warnings`
    );
    return results;
  } catch (err) {
    console.warn(
      "[ngaMaritime] NGA MSI fetch failed:",
      err instanceof Error ? err.message : err
    );
    const fallback = await fetchWmoNavareaFallback(nowSec, boundaries);
    console.log(
      `[ngaMaritime] Parsed ${fallback.length} fallback WMO maritime warnings`
    );
    return fallback;
  }
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
