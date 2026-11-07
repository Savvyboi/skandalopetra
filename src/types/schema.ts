import type { Feature, FeatureCollection, Geometry } from "geojson";

export type HazardDomain = "notam" | "maritime" | "weather";
export type HazardSubType =
  | "TFR"
  | "NOTAM"
  | "NAVAREA"
  | "SIGMET"
  | "METAR"
  | "TAF";
export type HazardSeverity = "info" | "warning" | "danger";

export interface AlertFeatureProperties {
  id: string;                 // Deterministic unique ID (e.g., "NGA-NAVAREA-IV-2026-142")
  domain: HazardDomain;
  subType: HazardSubType;
  severity: HazardSeverity;
  title: string;              // Concise summary (e.g., "NAVAREA IV Warning 142" or "EFHK LIFR METAR")
  rawText: string;            // Full verbatim bulletin text (METAR, TAF, NAVAREA, or NOTAM)
  stationOrArea?: string;     // ICAO code (e.g., "KJFK") or NAVAREA Roman numeral (e.g., "IV")
  issuedAt: number;           // Unix timestamp in seconds
  validFrom: number;          // Unix timestamp in seconds (start of effective window)
  validTo: number;            // Unix timestamp in seconds (end of effective window)
  altitudeMinFt?: number;     // Optional lower altitude limit in feet MSL
  altitudeMaxFt?: number;     // Optional upper altitude limit in feet MSL
}

export type HazardFeature = Feature<Geometry, AlertFeatureProperties>;

export interface HazardFeatureCollection extends FeatureCollection<Geometry, AlertFeatureProperties> {
  metadata: {
    generatedAt: number;      // Unix timestamp in seconds
    totalFeatures: number;
  };
}
