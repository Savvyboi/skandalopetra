import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { MultiPolygon, Polygon, Position } from "geojson";
import type { HazardFeature, HazardRegion } from "../../src/types/schema.ts";
import { computeDurationHours, computeGeometryAreaSqKm, coordsToGeoJsonGeometry } from "../utils/geometry.ts";

const HOST = "https://ospo.noaa.gov";
const INDEX = `${HOST}/products/atmosphere/vaac/messages.html`;
const USER_AGENT = "GlobalHazardTracker/1.0 (+https://github.com/Savvyboi/skandalopetra)";
const ISSUER = "NOAA Washington VAAC";
const RECENT_SECONDS = 36 * 3600;

const REGIONS: Record<string, [string, HazardRegion]> = {
  ECUADOR: ["Ecuador", "South America"], COLOMBIA: ["Colombia", "South America"],
  PERU: ["Peru", "South America"], CHILE: ["Chile", "South America"],
  BOLIVIA: ["Bolivia", "South America"], ARGENTINA: ["Argentina", "South America"],
  MEXICO: ["Mexico", "North America"], GUATEMALA: ["Guatemala", "North America"],
  NICARAGUA: ["Nicaragua", "North America"], "EL SALVADOR": ["El Salvador", "North America"],
  "COSTA RICA": ["Costa Rica", "North America"], MONTSERRAT: ["Montserrat", "North America"],
  "HAWAIIAN.IS": ["United States", "Oceania"], "UNITED STATES": ["United States", "North America"],
};

type XmlValue = string | { [key: string]: XmlValue } | XmlValue[] | undefined;
type AdvisoryLink = { bulletin: string; xml: string | undefined; listedAt: number };
type AdvisoryReport = { prefix: string; issuedAt: number; features: HazardFeature[] };

function node(value: XmlValue, ...path: string[]): XmlValue {
  for (const name of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = value[name];
  }
  return value;
}

function valueText(value: XmlValue): string | undefined {
  const text = typeof value === "string" ? value : node(value, "#text");
  return typeof text === "string" ? text.trim() || undefined : undefined;
}

function elements(value: XmlValue): XmlValue[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function time(value: XmlValue): number | undefined {
  const timestamp = valueText(node(value, "TimeInstant", "timePosition"));
  if (!timestamp || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(timestamp)) return undefined;
  const seconds = Math.floor(Date.parse(timestamp) / 1000);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function advisoryLinks(html: string, nowSec: number): (AdvisoryLink & { xml: string })[] {
  const latest = new Map<string, AdvisoryLink>();
  const rows = /href=["'](\/VAAC\/ARCH\d{2}\/([a-z0-9_-]+)\/(\d{4})([A-L])(\d\d)(\d\d)(\d\d)\.html)["'][^>]*>[^<]*<\/a>(?:\s*<a\s+href=["'](\/products\/atmosphere\/vaac\/volcanoes\/xml_files\/[A-Z0-9]{6}_\d{8}_\d{4}\.xml)["'])?/gi;
  for (const match of html.matchAll(rows)) {
    const [, bulletin, volcano, year, monthLetter, day, hour, minute, xml] = match;
    const month = String(monthLetter.toUpperCase().charCodeAt(0) - 64).padStart(2, "0");
    const listedAt = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:00Z`) / 1000;
    if (!Number.isFinite(listedAt) || listedAt > nowSec + 15 * 60) continue;
    const previous = latest.get(volcano);
    if (!previous || listedAt > previous.listedAt || (listedAt === previous.listedAt && !previous.xml)) {
      latest.set(volcano, { bulletin, xml, listedAt });
    }
  }
  if (!latest.size) throw new Error("Washington VAAC index did not contain recognizable bulletin links");
  return [...latest.values()].filter((link): link is AdvisoryLink & { xml: string } =>
    Boolean(link.xml) && link.listedAt >= nowSec - RECENT_SECONDS)
    .sort((a, b) => b.listedAt - a.listedAt).slice(0, 24);
}

function parseRing(ring: XmlValue, longitudeFirst: boolean): Position[] | undefined {
  const list = node(ring, "LinearRing", "posList");
  const raw = valueText(list);
  if (!raw) return undefined;
  const numbers = raw.split(/\s+/).map(Number);
  const count = valueText(node(list, "@_count"));
  if (numbers.length < 6 || numbers.length % 2 || (count && Number(count) !== numbers.length / 2)) return undefined;
  const points: [number, number][] = [];
  for (let index = 0; index < numbers.length; index += 2) {
    const lon = numbers[index + (longitudeFirst ? 0 : 1)];
    const lat = numbers[index + (longitudeFirst ? 1 : 0)];
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
    points.push([lon, lat]);
  }
  const geometry = coordsToGeoJsonGeometry(points);
  return geometry?.type === "Polygon" ? geometry.coordinates[0] : undefined;
}

function ashGeometry(surface: XmlValue): Polygon | MultiPolygon | undefined {
  const crs = valueText(node(surface, "@_srsName"));
  const dimensions = valueText(node(surface, "@_srsDimension"));
  const axes = valueText(node(surface, "@_axisLabels"));
  const isCrs84 = crs?.endsWith("/CRS84") || crs?.endsWith(":CRS84");
  if ((!isCrs84 && !crs?.match(/EPSG(?:\/0\/|::)4326$/)) || (dimensions && dimensions !== "2")) return undefined;
  if (axes && !/^(?:lat\s+lon(?:g)?|lon(?:g)?\s+lat)$/i.test(axes)) return undefined;
  const longitudeFirst = axes ? /^lon/i.test(axes) : Boolean(isCrs84);
  const patches = elements(node(surface, "patches", "PolygonPatch"));
  const polygons: Position[][][] = [];
  for (const patch of patches) {
    const exterior = parseRing(node(patch, "exterior"), longitudeFirst);
    if (!exterior) return undefined;
    const rings = [exterior];
    for (const hole of elements(node(patch, "interior"))) {
      const ring = parseRing(hole, longitudeFirst);
      if (!ring) return undefined;
      rings.push(ring);
    }
    polygons.push(rings);
  }
  if (!polygons.length) return undefined;
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons };
}

function altitude(limit: XmlValue, reference: XmlValue): { feet?: number; label: string } {
  const text = valueText(limit);
  const unit = valueText(node(limit, "@_uom"));
  const datum = valueText(reference);
  if (text === "GND" || text === "SFC") return { feet: 0, label: "SFC" };
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return { label: text ?? "unknown" };
  const numeric = Number(text);
  if (unit === "FL" && numeric < 999) return { feet: numeric * 100, label: `FL${text.padStart(3, "0")}` };
  if (datum === "MSL" && unit === "[ft_i]") return { feet: numeric, label: `${text} ft MSL` };
  if (datum === "MSL" && unit === "m") return { feet: Math.round(numeric / 0.3048), label: `${text} m MSL` };
  return { label: [text, unit, datum].filter(Boolean).join(" ") };
}

function parseAdvisory(xml: string, link: AdvisoryLink): AdvisoryReport | undefined {
  if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("Invalid IWXXM XML");
  const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false, processEntities: false });
  const document = parser.parse(xml) as XmlValue;
  const advisory = node(document, "MeteorologicalBulletin", "meteorologicalInformation", "VolcanicAshAdvisory");
  if (!advisory) throw new Error("IWXXM did not contain a volcanic ash advisory");
  if (node(advisory, "@_permissibleUsage") !== "OPERATIONAL") return undefined;
  const centre = node(advisory, "issuingVolcanicAshAdvisoryCentre", "Unit", "timeSlice", "UnitTimeSlice", "name");
  if (centre !== "WASHINGTON") return undefined;
  const name = valueText(node(advisory, "volcano", "EruptingVolcano", "name"));
  const volcano = /^(.*\S)\s+(\d{6})$/.exec(name ?? "");
  const issuedAt = time(node(advisory, "issueTime"));
  if (!volcano || issuedAt === undefined || Math.abs(issuedAt - link.listedAt) >= 60) return undefined;
  const [, volcanoName, volcanoNumber] = volcano;
  const prefix = `W-VAAC-ASH-${volcanoNumber}-`;
  const observation = node(advisory, "observation", "VolcanicAshObservedOrEstimatedConditions");
  const status = node(observation, "@_status");
  const clouds = elements(node(observation, "ashCloud"));
  if (status === "NOT_IDENTIFIABLE" && !clouds.length) return { prefix, issuedAt, features: [] };
  if (status !== "IDENTIFIABLE" || !clouds.length) return undefined;

  const observedAt = time(node(observation, "phenomenonTime"));
  const nextAdvisory = time(node(advisory, "nextAdvisoryTime"));
  if (observedAt === undefined || observedAt > issuedAt || nextAdvisory === undefined || nextAdvisory <= issuedAt) return undefined;
  const validTo = nextAdvisory - 1;
  const observedOrEstimated = node(observation, "@_isEstimated") === "true" ? "Estimated" : "Observed";
  const area = valueText(node(advisory, "stateOrRegion"));
  const [country, region] = REGIONS[area ?? ""] ?? [area ?? "Unknown", "High Seas"];
  const number = valueText(node(advisory, "advisoryNumber"));
  const source = valueText(node(advisory, "informationSource"));
  const remarks = valueText(node(advisory, "remarks"));
  const features: HazardFeature[] = [];

  for (const [index, cloud] of clouds.entries()) {
    const volume = node(cloud, "VolcanicAshCloudObservedOrEstimated", "ashCloudExtent", "AirspaceVolume");
    const geometry = ashGeometry(node(volume, "horizontalProjection", "Surface"));
    if (!geometry) continue;
    const areaSqKm = computeGeometryAreaSqKm(geometry);
    if (areaSqKm <= 0) continue;
    const lower = altitude(node(volume, "lowerLimit"), node(volume, "lowerLimitReference"));
    const upper = altitude(node(volume, "upperLimit"), node(volume, "upperLimitReference"));
    if (lower.feet !== undefined && upper.feet !== undefined && lower.feet > upper.feet) continue;
    const rawText = [
      `${ISSUER} advisory ${number ?? ""}`.trim(),
      `${volcanoName} (${volcanoNumber})`,
      `${observedOrEstimated} ash at ${new Date(observedAt * 1000).toISOString()}`,
      `Altitude ${lower.label} to ${upper.label}`,
      source, valueText(node(advisory, "eruptionDetails")), remarks,
    ].filter(Boolean).join("\n");

    features.push({
      type: "Feature", geometry,
      properties: {
        id: `${prefix}${issuedAt}-${index + 1}`,
        domain: "weather", subType: "VOLCANIC ASH", severity: "danger",
        title: `${volcanoName} volcanic ash · ${lower.label}–${upper.label}`,
        rawText, issuer: ISSUER, stationOrArea: volcanoName, country, region, areaSqKm,
        issuedAt, validFrom: issuedAt, validTo,
        durationHours: computeDurationHours(issuedAt, validTo),
        ...(lower.feet !== undefined ? { altitudeMinFt: lower.feet } : {}),
        ...(upper.feet !== undefined ? { altitudeMaxFt: upper.feet } : {}),
        sourceUrl: new URL(link.bulletin, HOST).href,
        geometryNote: `${observedOrEstimated} ash footprint at the stated altitude band. See the advisory for forecast footprints and flight levels.`,
        validityNote: "Shown from issue time until the next advisory is due or a replacement is issued.",
      },
    });
  }
  return features.length === clouds.length ? { prefix, issuedAt, features } : undefined;
}

export async function fetchWashingtonVaacHazards(
  nowSec: number,
  onIssued?: (idPrefix: string, issuedAt: number) => void,
): Promise<HazardFeature[]> {
  const headers = { "User-Agent": USER_AGENT };
  const index = await fetch(INDEX, { headers, signal: AbortSignal.timeout(20000) });
  if (!index.ok) throw new Error(`Washington VAAC index HTTP ${index.status}`);
  const links = advisoryLinks(await index.text(), nowSec);
  const results = await Promise.allSettled(links.map(async (link) => {
    const response = await fetch(new URL(link.xml, HOST), { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`IWXXM ${link.xml} HTTP ${response.status}`);
    return parseAdvisory(await response.text(), link);
  }));
  const reports = new Map<string, AdvisoryReport>();
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.warn(`[washingtonVaac] ${links[index].xml} unavailable:`, result.reason);
      continue;
    }
    const report = result.value;
    if (report && (reports.get(report.prefix)?.issuedAt ?? -Infinity) < report.issuedAt) reports.set(report.prefix, report);
  }
  const features: HazardFeature[] = [];
  for (const report of reports.values()) {
    onIssued?.(report.prefix, report.issuedAt);
    features.push(...report.features);
  }
  console.log(`[washingtonVaac] Parsed ${features.length} ash footprints from ${reports.size} operational advisories`);
  return features;
}
