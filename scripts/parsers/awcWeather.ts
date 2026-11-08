import zlib from "node:zlib";
import { parse } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import type { Geometry } from "geojson";
import type { HazardFeature, HazardSeverity } from "../../src/types/schema.ts";
import {
  computeDurationHours,
  computeGeometryAreaSqKm,
} from "../utils/geometry.ts";
import { resolveIcaoMetadata } from "../utils/icaoRegions.ts";

const USER_AGENT = "GlobalHazardTracker/1.0 (+https://github.com)";
const FETCH_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json, application/xml, text/csv, */*",
};

function toUnixSec(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) {
    return val > 1e12 ? Math.floor(val / 1000) : Math.floor(val);
  }
  if (typeof val === "string" && val.trim().length > 0) {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
    }
    const ms = Date.parse(trimmed);
    if (!Number.isNaN(ms)) {
      return Math.floor(ms / 1000);
    }
  }
  return null;
}

function isValidGeometry(geom: unknown): geom is Geometry {
  if (!geom || typeof geom !== "object") return false;
  const g = geom as { type?: string; coordinates?: unknown[] };
  if (!g.type || !Array.isArray(g.coordinates) || g.coordinates.length === 0) {
    return false;
  }
  if (g.type === "Polygon") {
    const ring = g.coordinates[0];
    return Array.isArray(ring) && ring.length >= 4;
  }
  return true;
}

async function fetchSigmets(nowSec: number): Promise<HazardFeature[]> {
  const endpoints = [
    {
      name: "ISIGMET",
      url: "https://aviationweather.gov/api/data/isigmet?format=geojson",
    },
    {
      name: "AIRSIGMET",
      url: "https://aviationweather.gov/api/data/airsigmet?format=geojson",
    },
  ];

  const results: HazardFeature[] = [];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        console.warn(`[awcWeather] ${ep.name} HTTP ${res.status}`);
        continue;
      }
      const fc = (await res.json()) as {
        features?: Array<{
          geometry?: unknown;
          properties?: Record<string, unknown>;
        }>;
      };
      if (!Array.isArray(fc.features)) continue;

      for (const item of fc.features) {
        if (!isValidGeometry(item.geometry) || !item.properties) continue;
        const p = item.properties;

        const validFrom = toUnixSec(p.validTimeFrom) ?? nowSec;
        const validTo = toUnixSec(p.validTimeTo) ?? validFrom + 14400;

        const hazard = String(
          p.hazard ?? p.airSigmetType ?? "SIGMET"
        ).toUpperCase();
        const qualifier = String(p.qualifier ?? "").toUpperCase();
        const rawText = String(
          p.rawSigmet ?? p.rawAirSigmet ?? p.rawText ?? ""
        ).trim();
        if (!rawText) continue;

        const firOrStation = String(
          p.firId ?? p.icaoId ?? "KJFK"
        ).toUpperCase();
        const seriesId = String(
          p.seriesId ?? p.alphaChar ?? validFrom
        ).replace(/\s+/g, "-");

        const isDanger =
          hazard === "VA" ||
          hazard === "TC" ||
          qualifier.includes("SEV") ||
          /\b(VA\s+CLD|ERUPTION|TROPICAL\s+CYCLONE|SEV\s+TURB|SEV\s+ICE|SEVERE\s+TURB|SEVERE\s+IC)/i.test(
            rawText
          );

        const severity: HazardSeverity = isDanger ? "danger" : "warning";

        const altLowRaw = p.base ?? p.altitudeLow1 ?? p.altitudeLow2;
        const altHighRaw = p.top ?? p.altitudeHi1 ?? p.altitudeHi2;
        const altitudeMinFt =
          altLowRaw !== null &&
          altLowRaw !== undefined &&
          altLowRaw !== "" &&
          Number.isFinite(Number(altLowRaw))
            ? Number(altLowRaw)
            : undefined;
        const altitudeMaxFt =
          altHighRaw !== null &&
          altHighRaw !== undefined &&
          altHighRaw !== "" &&
          Number.isFinite(Number(altHighRaw))
            ? Number(altHighRaw)
            : undefined;

        const meta = resolveIcaoMetadata(
          ep.name === "AIRSIGMET" ? "KZNY" : firOrStation,
          "weather"
        );

        const id = `AWC-${ep.name}-${firOrStation}-${seriesId}-${validFrom}`;
        const title = `${firOrStation} SIGMET ${seriesId} (${hazard})`;

        results.push({
          type: "Feature",
          geometry: item.geometry,
          properties: {
            id,
            domain: "weather",
            subType: "SIGMET",
            severity,
            title,
            rawText,
            stationOrArea: firOrStation,
            issuer: meta.issuer,
            country: meta.country,
            region: meta.region,
            areaSqKm: computeGeometryAreaSqKm(item.geometry),
            durationHours: computeDurationHours(validFrom, validTo),
            issuedAt: validFrom,
            validFrom,
            validTo,
            ...(altitudeMinFt !== undefined ? { altitudeMinFt } : {}),
            ...(altitudeMaxFt !== undefined ? { altitudeMaxFt } : {}),
          },
        });
      }
    } catch (err) {
      console.warn(
        `[awcWeather] Failed to fetch ${ep.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return results;
}

async function fetchMetars(nowSec: number): Promise<HazardFeature[]> {
  const url = "https://aviationweather.gov/data/cache/metars.cache.csv.gz";
  const results: HazardFeature[] = [];

  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.warn(`[awcWeather] METAR cache HTTP ${res.status}`);
      return results;
    }

    const compressed = Buffer.from(await res.arrayBuffer());
    const csvText = zlib.gunzipSync(compressed).toString("utf8");

    const lines = csvText.split(/\r?\n/);
    const headerIdx = lines.findIndex((line) =>
      line.startsWith("raw_text,station_id")
    );
    if (headerIdx === -1) {
      console.warn("[awcWeather] METAR CSV header row not found");
      return results;
    }

    const cleanCsv = lines.slice(headerIdx).join("\n");
    const records = parse(cleanCsv, {
      columns: (header: string[]) => {
        const counts = new Map<string, number>();
        return header.map((col) => {
          const c = counts.get(col) ?? 0;
          counts.set(col, c + 1);
          return c === 0 ? col : `${col}_${c}`;
        });
      },
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;

    const wxHazardRegex = /TS|SQ|FC|GR|FZRA|SN|FG|VA/;
    const wxDangerRegex = /TS|SQ|FC|FZRA|VA/;

    for (const row of records) {
      const stationId = (row.station_id ?? "").trim().toUpperCase();
      const rawText = (row.raw_text ?? "").trim();
      if (!stationId || !rawText) continue;

      const lat = parseFloat(row.latitude ?? "");
      const lon = parseFloat(row.longitude ?? "");
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180 ||
        (lat === 0 && lon === 0)
      ) {
        continue;
      }

      const flightCat = (row.flight_category ?? "").trim().toUpperCase();
      const windSpeedKt = parseFloat(row.wind_speed_kt ?? "0") || 0;
      const windGustKt = parseFloat(row.wind_gust_kt ?? "0") || 0;
      const wxString = (row.wx_string ?? "").trim().toUpperCase();

      const isIfrOrLifr = flightCat === "IFR" || flightCat === "LIFR";
      const isHighWind = windGustKt >= 25 || windSpeedKt >= 25;
      const isHazardousWx = wxHazardRegex.test(wxString);

      if (!isIfrOrLifr && !isHighWind && !isHazardousWx) {
        continue;
      }

      const isDanger =
        flightCat === "LIFR" ||
        windGustKt >= 35 ||
        wxDangerRegex.test(wxString);

      const severity: HazardSeverity = isDanger ? "danger" : "warning";
      const obsSec = toUnixSec(row.observation_time) ?? nowSec;
      const validFrom = obsSec;
      const validTo = obsSec + 5400; // 90 minutes

      const badgeParts: string[] = [];
      if (isIfrOrLifr) badgeParts.push(flightCat);
      if (wxString) badgeParts.push(wxString);
      else if (windGustKt >= 25) badgeParts.push(`G${Math.round(windGustKt)}KT`);
      else if (windSpeedKt >= 25) badgeParts.push(`${Math.round(windSpeedKt)}KT`);

      const summaryTag = badgeParts.join(" ") || "HAZARD";
      const title = `${stationId} ${summaryTag} METAR`;
      const meta = resolveIcaoMetadata(stationId, "weather");

      results.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [Number(lon.toFixed(4)), Number(lat.toFixed(4))],
        },
        properties: {
          id: `AWC-METAR-${stationId}-${obsSec}`,
          domain: "weather",
          subType: "METAR",
          severity,
          title,
          rawText,
          stationOrArea: stationId,
          issuer: meta.issuer,
          country: meta.country,
          region: meta.region,
          areaSqKm: 0,
          durationHours: 1.5,
          issuedAt: obsSec,
          validFrom,
          validTo,
        },
      });
    }
  } catch (err) {
    console.warn(
      "[awcWeather] Failed to fetch/parse METAR cache:",
      err instanceof Error ? err.message : err
    );
  }

  return results;
}

function asArray<T>(val: T | T[] | undefined | null): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function parseVisibilitySm(visRaw: unknown): number | null {
  if (visRaw === undefined || visRaw === null) return null;
  const s = String(visRaw).trim();
  if (!s || s.includes("+")) return 10;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

async function fetchTafs(nowSec: number): Promise<HazardFeature[]> {
  const url = "https://aviationweather.gov/data/cache/tafs.cache.xml.gz";
  const results: HazardFeature[] = [];

  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok) {
      console.warn(`[awcWeather] TAF cache HTTP ${res.status}`);
      return results;
    }

    const compressed = Buffer.from(await res.arrayBuffer());
    const xmlText = zlib.gunzipSync(compressed).toString("utf8");

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseTagValue: false,
    });
    const parsed = parser.parse(xmlText) as {
      response?: {
        data?: {
          TAF?: Array<Record<string, unknown>> | Record<string, unknown>;
        };
      };
    };

    const tafs = asArray(parsed?.response?.data?.TAF);
    const tafWxRegex = /TS|FZRA|SN|FG|SQ|GR/;
    const tafDangerWxRegex = /TS|FZRA|SQ|GR/;

    for (const taf of tafs) {
      const stationId = String(taf.station_id ?? "").trim().toUpperCase();
      const rawText = String(taf.raw_text ?? "").trim();
      if (!stationId || !rawText) continue;

      const lat = parseFloat(String(taf.latitude ?? ""));
      const lon = parseFloat(String(taf.longitude ?? ""));
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180 ||
        (lat === 0 && lon === 0)
      ) {
        continue;
      }

      const issuedAt =
        toUnixSec(taf.issue_time) ?? toUnixSec(taf.bulletin_time) ?? nowSec;
      const meta = resolveIcaoMetadata(stationId, "weather");
      const forecasts = asArray(
        taf.forecast as Record<string, unknown> | Array<Record<string, unknown>>
      );

      for (const fcst of forecasts) {
        const validFrom = toUnixSec(fcst.fcst_time_from);
        const validTo = toUnixSec(fcst.fcst_time_to);
        if (!validFrom || !validTo || validTo <= validFrom) continue;

        let minCeilingFt: number | null = null;
        const skyConds = asArray(
          fcst.sky_condition as
            | Record<string, unknown>
            | Array<Record<string, unknown>>
        );
        for (const sky of skyConds) {
          const cover = String(sky["@_sky_cover"] ?? "").toUpperCase();
          if (cover === "BKN" || cover === "OVC" || cover === "OVX") {
            const base = parseFloat(String(sky["@_cloud_base_ft_agl"] ?? ""));
            if (Number.isFinite(base)) {
              minCeilingFt =
                minCeilingFt === null ? base : Math.min(minCeilingFt, base);
            }
          }
        }
        if (fcst.vert_vis_ft !== undefined) {
          const vv = parseFloat(String(fcst.vert_vis_ft));
          if (Number.isFinite(vv)) {
            minCeilingFt =
              minCeilingFt === null ? vv : Math.min(minCeilingFt, vv);
          }
        }

        const visSm = parseVisibilitySm(fcst.visibility_statute_mi);
        const windGustKt = parseFloat(String(fcst.wind_gust_kt ?? "0")) || 0;
        const wxString = String(fcst.wx_string ?? "").trim().toUpperCase();

        const hasLowCeiling = minCeilingFt !== null && minCeilingFt < 1000;
        const hasLowVis = visSm !== null && visSm < 3;
        const hasHighGust = windGustKt >= 25;
        const hasHazWx = tafWxRegex.test(wxString);

        if (!hasLowCeiling && !hasLowVis && !hasHighGust && !hasHazWx) {
          continue;
        }

        const isDanger =
          (minCeilingFt !== null && minCeilingFt < 500) ||
          (visSm !== null && visSm < 1) ||
          windGustKt >= 35 ||
          tafDangerWxRegex.test(wxString);

        const severity: HazardSeverity = isDanger ? "danger" : "warning";

        const reasons: string[] = [];
        if (hasHazWx) reasons.push(wxString);
        if (hasLowCeiling && minCeilingFt !== null) {
          reasons.push(`CIG ${Math.round(minCeilingFt)}FT`);
        }
        if (hasLowVis && visSm !== null) {
          reasons.push(`VIS ${visSm}SM`);
        }
        if (hasHighGust) {
          reasons.push(`G${Math.round(windGustKt)}KT`);
        }

        const title = `${stationId} TAF (${reasons.slice(0, 2).join(", ")})`;

        results.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [Number(lon.toFixed(4)), Number(lat.toFixed(4))],
          },
          properties: {
            id: `AWC-TAF-${stationId}-${validFrom}-${validTo}`,
            domain: "weather",
            subType: "TAF",
            severity,
            title,
            rawText,
            stationOrArea: stationId,
            issuer: meta.issuer,
            country: meta.country,
            region: meta.region,
            areaSqKm: 0,
            durationHours: computeDurationHours(validFrom, validTo),
            issuedAt,
            validFrom,
            validTo,
            ...(minCeilingFt !== null
              ? { altitudeMaxFt: Math.round(minCeilingFt) }
              : {}),
          },
        });
      }
    }
  } catch (err) {
    console.warn(
      "[awcWeather] Failed to fetch/parse TAF cache:",
      err instanceof Error ? err.message : err
    );
  }

  return results;
}

export async function fetchAwcWeatherHazards(
  nowSec: number
): Promise<HazardFeature[]> {
  const [sigmets, metars, tafs] = await Promise.all([
    fetchSigmets(nowSec),
    fetchMetars(nowSec),
    fetchTafs(nowSec),
  ]);
  console.log(
    `[awcWeather] Parsed ${sigmets.length} SIGMETs, ${metars.length} METARs, ${tafs.length} TAF windows`
  );
  return [...sigmets, ...metars, ...tafs];
}
