import type { Geometry } from "geojson";
import type { HazardFeature, HazardSeverity } from "../../src/types/schema.ts";
import {
  coordsToGeoJsonGeometry,
  createNmCircleGeometry,
  parseNotamQLineCircle,
} from "../utils/geometry.ts";

const USER_AGENT = "GlobalHazardTracker/1.0 (+https://github.com)";
const FETCH_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/json, text/plain, */*",
};

interface FaaTfrListItem {
  notam_id?: string;
  type?: string;
  facility?: string;
  state?: string;
  description?: string;
  creation_date?: string;
}

interface ParsedWebTextInfo {
  cleanText: string;
  issuedAt?: number;
  validFrom?: number;
  validTo?: number;
  altitudeMinFt?: number;
  altitudeMaxFt?: number;
  fallbackGeometry?: Geometry | null;
}

function decodeHtmlEntities(input: string): string {
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
    .replace(/&quot;/gi, '"');
}

function htmlTableToCleanText(html: string): string {
  const decoded = decodeHtmlEntities(html);
  return decoded
    .replace(/<b>ENDSECTION\d+<\/b>/gi, "\n")
    .replace(/<a[^>]*>\s*(?:Top|Download shapefiles)\s*<\/a>/gi, "")
    .replace(/Jump To:[\s\S]*?<\/TR>/gi, "")
    .replace(/<\/TR>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/TD>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && line !== "Top")
    .join("\n");
}

function parseFaaHumanUtcDate(str: string): number | undefined {
  // Matches e.g. "November 08, 2026 at 0900 UTC" or "May 6, 2025 at 1430 EDT"
  const m =
    /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{2})(\d{2})\s*([A-Z]{2,4})?/i.exec(
      str
    );
  if (!m) return undefined;

  const monthNames: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };
  const month = monthNames[m[1].toLowerCase()];
  if (month === undefined) return undefined;

  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const tz = (m[6] ?? "UTC").toUpperCase();

  const tzOffsetsHours: Record<string, number> = {
    UTC: 0,
    GMT: 0,
    Z: 0,
    EDT: -4,
    EST: -5,
    CDT: -5,
    CST: -6,
    MDT: -6,
    MST: -7,
    PDT: -7,
    PST: -8,
    AKDT: -8,
    AKST: -9,
    HST: -10,
  };
  const offsetHr = tzOffsetsHours[tz] ?? 0;
  const utcMs =
    Date.UTC(year, month, day, hour, minute, 0) - offsetHr * 3600 * 1000;
  return Math.floor(utcMs / 1000);
}

function parseAltitudes(text: string): {
  altitudeMinFt?: number;
  altitudeMaxFt?: number;
} {
  let altitudeMinFt: number | undefined;
  let altitudeMaxFt: number | undefined;

  const altLineMatch = /Altitude\s*:\s*([^\n]+)/i.exec(text);
  const line = altLineMatch ? altLineMatch[1] : text;

  if (/from\s+the\s+surface/i.test(line)) {
    altitudeMinFt = 0;
  } else {
    const lowMatch = /from\s+(\d{1,6})\s*feet/i.exec(line);
    const lowFl = /from\s+FL\s*(\d{2,3})/i.exec(line);
    if (lowMatch) altitudeMinFt = parseInt(lowMatch[1], 10);
    else if (lowFl) altitudeMinFt = parseInt(lowFl[1], 10) * 100;
  }

  const upToFt =
    /(?:up\s+to(?:\s+and\s+including)?|to(?:\s+and\s+including)?)\s+(\d{1,6})\s*feet/i.exec(
      line
    );
  const upToFl =
    /(?:up\s+to(?:\s+and\s+including)?|to(?:\s+and\s+including)?)\s+(?:FL\s*|flight\s+level\s+)(\d{2,3})/i.exec(
      line
    );
  if (upToFt) altitudeMaxFt = parseInt(upToFt[1], 10);
  else if (upToFl) altitudeMaxFt = parseInt(upToFl[1], 10) * 100;
  else if (/unlimited/i.test(line)) altitudeMaxFt = 60000;

  return { altitudeMinFt, altitudeMaxFt };
}

function parseDmsGeometryFromWebText(cleanText: string): Geometry | null {
  // Matches e.g.: Latitude: 28º01'52"N, Longitude: 81º46'52"W
  const dmsRegex =
    /Latitude:\s*(\d{1,2})[^\d]+(\d{1,2})'([\d.]+)"\s*([NS]),\s*Longitude:\s*(\d{1,3})[^\d]+(\d{1,2})'([\d.]+)"\s*([EW])/gi;
  const coords: [number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = dmsRegex.exec(cleanText)) !== null) {
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
      coords.push([Number(lon.toFixed(5)), Number(lat.toFixed(5))]);
    }
  }

  if (coords.length === 1) {
    const radMatch = /Radius\s*:\s*([\d.]+)\s*nautical\s+miles/i.exec(cleanText);
    const radiusNm = radMatch ? parseFloat(radMatch[1]) : 3;
    return createNmCircleGeometry(coords[0][0], coords[0][1], radiusNm);
  }
  return coordsToGeoJsonGeometry(coords);
}

async function fetchTfrWebText(
  notamId: string
): Promise<ParsedWebTextInfo | null> {
  try {
    const url = `https://tfr.faa.gov/tfrapi/getWebText?notamId=${encodeURIComponent(
      notamId
    )}`;
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const arr = (await res.json()) as Array<{ text?: string }>;
    const rawHtml = arr?.[0]?.text;
    if (!rawHtml) return null;

    const cleanText = htmlTableToCleanText(rawHtml);

    const issueMatch = /Issue Date\s*:\s*([^\n]+)/i.exec(cleanText);
    const beginMatch = /Beginning Date and Time\s*:\s*([^\n]+)/i.exec(cleanText);
    const endMatch = /Ending Date and Time\s*:\s*([^\n]+)/i.exec(cleanText);

    const issuedAt = issueMatch
      ? parseFaaHumanUtcDate(issueMatch[1])
      : undefined;
    const validFrom = beginMatch
      ? parseFaaHumanUtcDate(beginMatch[1])
      : undefined;
    const validTo = endMatch ? parseFaaHumanUtcDate(endMatch[1]) : undefined;
    const { altitudeMinFt, altitudeMaxFt } = parseAltitudes(cleanText);
    const fallbackGeometry = parseDmsGeometryFromWebText(cleanText);

    return {
      cleanText,
      issuedAt,
      validFrom,
      validTo,
      altitudeMinFt,
      altitudeMaxFt,
      fallbackGeometry,
    };
  } catch {
    return null;
  }
}

async function fetchWfsTfrGeometries(): Promise<Map<string, Geometry[]>> {
  const geomMap = new Map<string, Geometry[]>();
  const wfsUrl =
    "https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=500&outputFormat=application/json&srsname=EPSG:4326";

  try {
    const res = await fetch(wfsUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.warn(`[faaNotam] TFR WFS HTTP ${res.status}`);
      return geomMap;
    }

    const fc = (await res.json()) as {
      features?: Array<{
        id?: string;
        geometry?: Geometry;
        properties?: Record<string, unknown>;
      }>;
    };

    for (const feat of fc.features ?? []) {
      if (!feat.geometry) continue;
      const keyProp = String(feat.properties?.NOTAM_KEY ?? "");
      const keyMatch = /^(\d+\/\d+)/.exec(keyProp);
      const idMatch = /V_TFR_LOC\.(\d+\/\d+)/.exec(String(feat.id ?? ""));
      const notamId = keyMatch?.[1] ?? idMatch?.[1];
      if (!notamId) continue;

      const list = geomMap.get(notamId) ?? [];
      list.push(feat.geometry);
      geomMap.set(notamId, list);
    }
  } catch (err) {
    console.warn(
      "[faaNotam] Failed to fetch TFR WFS geometries:",
      err instanceof Error ? err.message : err
    );
  }
  return geomMap;
}

async function fetchUnauthenticatedFaaTfrs(
  nowSec: number
): Promise<HazardFeature[]> {
  const listUrl = "https://tfr.faa.gov/tfrapi/exportTfrList";
  const features: HazardFeature[] = [];

  try {
    const [listRes, wfsMap] = await Promise.all([
      fetch(listUrl, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(20000),
      }),
      fetchWfsTfrGeometries(),
    ]);

    if (!listRes.ok) {
      console.warn(`[faaNotam] exportTfrList HTTP ${listRes.status}`);
      return features;
    }

    const tfrItems = (await listRes.json()) as FaaTfrListItem[];
    if (!Array.isArray(tfrItems)) return features;

    // Fetch web text in small batches of 10 so we don't overwhelm FAA servers
    const detailsMap = new Map<string, ParsedWebTextInfo>();
    const batchSize = 10;
    for (let i = 0; i < tfrItems.length; i += batchSize) {
      const batch = tfrItems.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (item) => {
          const id = item.notam_id?.trim();
          if (!id) return;
          const info = await fetchTfrWebText(id);
          if (info) detailsMap.set(id, info);
        })
      );
    }

    for (const item of tfrItems) {
      const notamId = item.notam_id?.trim();
      if (!notamId) continue;

      const info = detailsMap.get(notamId);
      const wfsGeoms = wfsMap.get(notamId) ?? [];
      const geometries: Geometry[] =
        wfsGeoms.length > 0
          ? wfsGeoms
          : info?.fallbackGeometry
          ? [info.fallbackGeometry]
          : [];

      if (geometries.length === 0) continue;

      const creationMs = item.creation_date
        ? Date.parse(item.creation_date)
        : NaN;
      const fallbackCreatedSec = !Number.isNaN(creationMs)
        ? Math.floor(creationMs / 1000)
        : nowSec;

      const issuedAt = info?.issuedAt ?? fallbackCreatedSec;
      const validFrom = info?.validFrom ?? issuedAt;
      const validTo =
        info?.validTo && info.validTo > validFrom
          ? info.validTo
          : nowSec + 7 * 86400;

      const facility = item.facility?.trim().toUpperCase() || "FAA";
      const tfrType = item.type?.trim().toUpperCase() || "TFR";
      const state = item.state?.trim().toUpperCase() || "";
      const title = `FDC ${notamId} ${tfrType} TFR${
        state ? ` (${state})` : ""
      }`;

      const rawText =
        info?.cleanText ||
        `FDC ${notamId} — ${tfrType} TFR\nFacility: ${facility}\nLocation: ${
          item.description ?? "N/A"
        }\nCreated: ${item.creation_date ?? "N/A"}`;

      geometries.forEach((geom, idx) => {
        const suffix = idx === 0 ? "" : `-AREA-${idx + 1}`;
        features.push({
          type: "Feature",
          geometry: geom,
          properties: {
            id: `FAA-TFR-${notamId.replace("/", "-")}${suffix}`,
            domain: "notam",
            subType: "TFR",
            severity: "danger",
            title:
              geometries.length > 1
                ? `${title} [Area ${idx + 1}]`
                : title,
            rawText,
            stationOrArea: facility,
            issuedAt,
            validFrom,
            validTo,
            ...(info?.altitudeMinFt !== undefined
              ? { altitudeMinFt: info.altitudeMinFt }
              : {}),
            ...(info?.altitudeMaxFt !== undefined
              ? { altitudeMaxFt: info.altitudeMaxFt }
              : {}),
          },
        });
      });
    }
  } catch (err) {
    console.warn(
      "[faaNotam] Failed to fetch unauthenticated FAA TFR feed:",
      err instanceof Error ? err.message : err
    );
  }

  return features;
}

async function fetchAuthenticatedFaaNotams(
  nowSec: number
): Promise<HazardFeature[]> {
  const clientId = process.env.FAA_CLIENT_ID?.trim();
  const clientSecret = process.env.FAA_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return [];
  }

  const url =
    "https://external-api.faa.gov/notamapi/v1/notams?responseFormat=geoJson&pageSize=1000";
  const features: HazardFeature[] = [];

  try {
    const res = await fetch(url, {
      headers: {
        ...FETCH_HEADERS,
        client_id: clientId,
        client_secret: clientSecret,
      },
      signal: AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      console.warn(`[faaNotam] Authenticated FAA NOTAM API HTTP ${res.status}`);
      return features;
    }

    const data = (await res.json()) as {
      items?: Array<{
        geometry?: Geometry;
        properties?: {
          coreNOTAMData?: {
            notam?: Record<string, unknown>;
            notamTranslation?: Array<{ formattedText?: string }>;
          };
        };
      }>;
    };

    for (const item of data.items ?? []) {
      const notam = item.properties?.coreNOTAMData?.notam;
      if (!notam) continue;

      const idNum = String(notam.id ?? notam.number ?? "");
      const icaoLocation = String(
        notam.icaoLocation ?? notam.location ?? "FAA"
      ).toUpperCase();
      const rawText = String(
        item.properties?.coreNOTAMData?.notamTranslation?.[0]?.formattedText ??
          notam.text ??
          ""
      ).trim();
      if (!rawText) continue;

      let geometry: Geometry | null = item.geometry ?? null;
      if (!geometry) {
        const qCoord = String(notam.coordinates ?? "");
        const radiusStr = String(notam.radius ?? "005").padStart(3, "0");
        if (qCoord) {
          geometry = parseNotamQLineCircle(`${qCoord}${radiusStr}`);
        }
      }
      if (!geometry) {
        const qMatch = /\b(\d{4}[NS]\d{5}[EW]\d{3})\b/.exec(rawText);
        if (qMatch) {
          geometry = parseNotamQLineCircle(qMatch[1]);
        }
      }
      if (!geometry) continue;

      const issuedMs = Date.parse(String(notam.issued ?? ""));
      const startMs = Date.parse(String(notam.effectiveStart ?? ""));
      const endMs = Date.parse(String(notam.effectiveEnd ?? ""));

      const issuedAt = !Number.isNaN(issuedMs)
        ? Math.floor(issuedMs / 1000)
        : nowSec;
      const validFrom = !Number.isNaN(startMs)
        ? Math.floor(startMs / 1000)
        : issuedAt;
      const validTo = !Number.isNaN(endMs)
        ? Math.floor(endMs / 1000)
        : nowSec + 7 * 86400;

      const severity: HazardSeverity =
        /CLOSED|CLSD|PROHIBITED|RESTRICTED|TFR|UNSERVICEABLE|HAZARD/i.test(
          rawText
        )
          ? "danger"
          : "warning";

      features.push({
        type: "Feature",
        geometry,
        properties: {
          id: `FAA-NOTAM-${icaoLocation}-${idNum || validFrom}`,
          domain: "notam",
          subType: "NOTAM",
          severity,
          title: `${icaoLocation} NOTAM ${notam.number ?? idNum}`,
          rawText,
          stationOrArea: icaoLocation,
          issuedAt,
          validFrom,
          validTo,
        },
      });
    }
  } catch (err) {
    console.warn(
      "[faaNotam] Authenticated FAA NOTAM API error:",
      err instanceof Error ? err.message : err
    );
  }

  return features;
}

export async function fetchFaaNotamHazards(
  nowSec: number
): Promise<HazardFeature[]> {
  const [tfrs, notams] = await Promise.all([
    fetchUnauthenticatedFaaTfrs(nowSec),
    fetchAuthenticatedFaaNotams(nowSec),
  ]);
  console.log(
    `[faaNotam] Parsed ${tfrs.length} FAA TFR polygons, ${notams.length} authenticated NOTAMs`
  );
  return [...tfrs, ...notams];
}
