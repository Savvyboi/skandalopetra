import type { Feature, FeatureCollection, Geometry } from "geojson";

export type HazardDomain = "notam" | "maritime" | "weather";

export const HAZARD_SUB_TYPES = [
  "NOTAM", "TFR", "NAS STATUS", "NAVAREA", "NAVTEX", "NAVWARN", "MARINE WEATHER",
  "SIGMET", "AIRMET", "CWA", "METAR", "TAF", "NWS ALERT", "CANADA WEATHER",
  "TROPICAL CYCLONE", "VOLCANIC ASH",
] as const;

export type HazardSubType = (typeof HAZARD_SUB_TYPES)[number];

export type HazardSeverity = "info" | "warning" | "danger";

export type HazardRegion =
  | "Europe"
  | "Middle East"
  | "Africa"
  | "Asia"
  | "Oceania"
  | "North America"
  | "South America"
  | "High Seas";

export interface AlertFeatureProperties {
  id: string;                 // Deterministic unique ID (e.g., "UKHO-NAVAREA-I-2026-240")
  domain: HazardDomain;
  subType: HazardSubType;
  severity: HazardSeverity;
  title: string;              // Concise summary (e.g., "LGGG NOTAM A4116/26 — Restricted Area")
  rawText: string;            // Full verbatim bulletin text (METAR, TAF, NAVAREA, NAVTEX, or NOTAM)
  stationOrArea?: string;     // ICAO code (e.g., "LGGG", "EGTT") or NAVAREA numeral (e.g., "XI")
  issuer: string;             // Issuing authority (e.g., "UKHO Admiralty", "HCAA Greece", "JCG Japan", "FAA (US)")
  country: string;            // Country or ocean territory (e.g., "Greece", "United Kingdom", "Japan")
  region: HazardRegion;       // Geographic region for fast continent-level filtering
  areaSqKm: number;           // Precomputed footprint area in square kilometers (0 for Point)
  durationHours: number;      // Precomputed effective duration in hours
  issuedAt: number;           // Unix timestamp in seconds
  validFrom: number;          // Unix timestamp in seconds (start of effective window)
  validTo: number;            // Unix timestamp in seconds (end of effective window)
  altitudeMinFt?: number;     // Optional lower altitude limit in feet MSL
  altitudeMaxFt?: number;     // Optional upper altitude limit in feet MSL
  sourceUrl?: string;        // Official bulletin or product page
  geometryNote?: string;     // Explanation for approximate or representative geometry
  validityNote?: string;     // Explanation for a source without a published end time
}

export type HazardFeature = Feature<Geometry, AlertFeatureProperties>;

export interface HazardFeatureCollection extends FeatureCollection<Geometry, AlertFeatureProperties> {
  metadata: {
    generatedAt: number;      // Unix timestamp in seconds
    totalFeatures: number;
  };
}
