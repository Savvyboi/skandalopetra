import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type {
  AlertFeatureProperties,
  HazardFeatureCollection,
  HazardRegion,
} from "../types/schema";
import type {
  DurationFilterPreset,
  SizeFilterPreset,
} from "./FilterPills";

setWorkerUrl(new URL(maplibreWorkerUrl, window.location.href).href);

const DEFAULT_REPO_FEED =
  "https://raw.githubusercontent.com/Savvyboi/skandalopetra/data-feed/alerts.geojson";

const HAZARD_LAYERS = [
  "hazards-points",
  "hazards-outline",
  "hazards-fill",
] as const;

export interface MapFilterCriteria {
  timestampSec: number;
  referenceNowSec: number;
  domains: string[];
  subTypes: string[];
  severities: string[];
  region: HazardRegion | "all";
  issuer: string;
  sizePreset: SizeFilterPreset;
  recencyHours: number;
  durationPreset: DurationFilterPreset;
  searchQuery: string;
}

export interface SelectedMapHazard {
  properties: AlertFeatureProperties;
  lngLat: [number, number];
}

export interface MapCanvasCallbacks {
  onSelectFeature: (selection: SelectedMapHazard) => void;
  onDataLoaded: (collection: HazardFeatureCollection) => void;
  onDataError?: (message: string) => void;
}

export function applyMapFilters(
  map: MapLibreMap,
  criteria: MapFilterCriteria
): void {
  if (!map.getLayer("hazards-fill")) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseConditions: any[] = [
    ["in", ["get", "domain"], ["literal", criteria.domains]],
    ["in", ["get", "subType"], ["literal", criteria.subTypes]],
    ["in", ["get", "severity"], ["literal", criteria.severities]],
    ["<=", ["get", "validFrom"], criteria.timestampSec],
    [">=", ["get", "validTo"], criteria.timestampSec],
  ];

  if (criteria.region !== "all") {
    baseConditions.push([
      "==",
      ["coalesce", ["get", "region"], ""],
      criteria.region,
    ]);
  }

  if (criteria.issuer !== "all") {
    baseConditions.push([
      "==",
      ["coalesce", ["get", "issuer"], ""],
      criteria.issuer,
    ]);
  }

  // Area / Footprint Size GPU Expressions
  const areaExpr = ["coalesce", ["get", "areaSqKm"], 0];
  switch (criteria.sizePreset) {
    case "no-giant":
      baseConditions.push(["<=", areaExpr, 200000]);
      break;
    case "point":
      baseConditions.push(["<", areaExpr, 10]);
      break;
    case "local":
      baseConditions.push([">=", areaExpr, 10]);
      baseConditions.push(["<=", areaExpr, 1000]);
      break;
    case "regional":
      baseConditions.push([">", areaExpr, 1000]);
      baseConditions.push(["<=", areaExpr, 50000]);
      break;
    case "large":
      baseConditions.push([">", areaExpr, 50000]);
      break;
    case "all":
    default:
      break;
  }

  // Issued Recency GPU Expression
  if (criteria.recencyHours > 0) {
    const minIssuedSec =
      criteria.referenceNowSec - criteria.recencyHours * 3600;
    baseConditions.push([
      ">=",
      ["coalesce", ["get", "issuedAt"], 0],
      minIssuedSec,
    ]);
  }

  // Effective Duration GPU Expression
  const durExpr = ["coalesce", ["get", "durationHours"], 0];
  switch (criteria.durationPreset) {
    case "short":
      baseConditions.push(["<", durExpr, 6]);
      break;
    case "medium":
      baseConditions.push([">=", durExpr, 6]);
      baseConditions.push(["<=", durExpr, 48]);
      break;
    case "long":
      baseConditions.push([">", durExpr, 48]);
      break;
    case "all":
    default:
      break;
  }

  if (criteria.searchQuery.trim().length > 0) {
    const q = criteria.searchQuery.trim().toUpperCase();
    baseConditions.push([
      "any",
      ["in", q, ["upcase", ["coalesce", ["get", "title"], ""]]],
      ["in", q, ["upcase", ["coalesce", ["get", "stationOrArea"], ""]]],
      ["in", q, ["upcase", ["coalesce", ["get", "issuer"], ""]]],
      ["in", q, ["upcase", ["coalesce", ["get", "country"], ""]]],
      ["in", q, ["upcase", ["coalesce", ["get", "rawText"], ""]]],
    ]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const combinedFilter: any = ["all", ...baseConditions];

  map.setFilter("hazards-fill", [
    "all",
    ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
    combinedFilter,
  ]);
  map.setFilter("hazards-outline", [
    "all",
    [
      "in",
      ["geometry-type"],
      ["literal", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]],
    ],
    combinedFilter,
  ]);
  map.setFilter("hazards-points", [
    "all",
    ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
    combinedFilter,
  ]);
}

async function fetchHazardCollection(): Promise<HazardFeatureCollection> {
  const configuredUrl = import.meta.env.VITE_DATA_FEED_URL?.trim();
  const candidates = Array.from(
    new Set(
      [
        configuredUrl,
        import.meta.env.PROD ? DEFAULT_REPO_FEED : "./alerts.geojson",
        "./alerts.geojson",
        DEFAULT_REPO_FEED,
      ].filter((u): u is string => Boolean(u))
    )
  );

  const cacheBucket = Math.floor(Date.now() / 60000);
  for (const url of candidates) {
    try {
      const bustUrl = url.startsWith("http")
        ? `${url}${url.includes("?") ? "&" : "?"}t=${cacheBucket}`
        : url;
      const res = await fetch(bustUrl);
      if (!res.ok) continue;
      const json = (await res.json()) as HazardFeatureCollection;
      if (
        json &&
        json.type === "FeatureCollection" &&
        Array.isArray(json.features)
      ) {
        return json;
      }
    } catch {
      // Try next candidate feed URL
    }
  }

  throw new Error(
    "Unable to load hazard GeoJSON feed from remote or local cache."
  );
}

function normalizeFeatureProperties(
  raw: Record<string, unknown>
): AlertFeatureProperties {
  return {
    id: String(raw.id ?? ""),
    domain: (raw.domain as AlertFeatureProperties["domain"]) ?? "weather",
    subType: (raw.subType as AlertFeatureProperties["subType"]) ?? "METAR",
    severity: (raw.severity as AlertFeatureProperties["severity"]) ?? "warning",
    title: String(raw.title ?? "Untitled Hazard"),
    rawText: String(raw.rawText ?? ""),
    stationOrArea:
      raw.stationOrArea !== undefined && raw.stationOrArea !== null
        ? String(raw.stationOrArea)
        : undefined,
    issuer: String(raw.issuer ?? "Unknown Authority"),
    country: String(raw.country ?? "Global"),
    region: (raw.region as AlertFeatureProperties["region"]) ?? "High Seas",
    areaSqKm: Number(raw.areaSqKm ?? 0),
    durationHours: Number(raw.durationHours ?? 0),
    issuedAt: Number(raw.issuedAt ?? 0),
    validFrom: Number(raw.validFrom ?? 0),
    validTo: Number(raw.validTo ?? 0),
    altitudeMinFt:
      raw.altitudeMinFt !== undefined && raw.altitudeMinFt !== null
        ? Number(raw.altitudeMinFt)
        : undefined,
    altitudeMaxFt:
      raw.altitudeMaxFt !== undefined && raw.altitudeMaxFt !== null
        ? Number(raw.altitudeMaxFt)
        : undefined,
  };
}

/**
 * Prioritizes Point features first, then LineStrings, then smaller Polygons before huge regional boxes
 * so hovering/clicking an overlapping pinpoint hazard never gets blocked by a large background polygon.
 */
function pickMostSpecificHit(hits: MapGeoJSONFeature[]): MapGeoJSONFeature {
  if (hits.length <= 1) return hits[0];
  const sorted = [...hits].sort((a, b) => {
    const rankGeom = (t: string) =>
      t === "Point" || t === "MultiPoint"
        ? 0
        : t === "LineString" || t === "MultiLineString"
        ? 1
        : 2;
    const ra = rankGeom(a.geometry.type);
    const rb = rankGeom(b.geometry.type);
    if (ra !== rb) return ra - rb;
    const areaA = Number(a.properties?.areaSqKm ?? 0);
    const areaB = Number(b.properties?.areaSqKm ?? 0);
    return areaA - areaB;
  });
  return sorted[0];
}

export function initMapCanvas(
  container: HTMLElement,
  initialCriteria: MapFilterCriteria,
  callbacks: MapCanvasCallbacks
): {
  map: MapLibreMap;
  updateFilters: (criteria: MapFilterCriteria) => void;
} {
  let latestCriteria: MapFilterCriteria = {
    ...initialCriteria,
    domains: [...initialCriteria.domains],
    subTypes: [...initialCriteria.subTypes],
    severities: [...initialCriteria.severities],
  };

  const map = new MapLibreMap({
    container,
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [12, 28],
    zoom: 2.2,
    minZoom: 1.2,
    maxZoom: 16,
    attributionControl: false,
  });

  Object.defineProperty(container, "__maplibreMap", {
    value: map,
    configurable: true,
  });

  map.addControl(new AttributionControl({ compact: true }), "bottom-right");
  map.addControl(
    new NavigationControl({ showCompass: true, visualizePitch: false }),
    "top-right"
  );

  const hoverPopup = new Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: "300px",
    offset: 12,
    className: "hazard-hover-popup",
  });

  const dataPromise = fetchHazardCollection()
    .then((collection) => {
      callbacks.onDataLoaded(collection);
      return collection;
    })
    .catch((err) => {
      const msg =
        err instanceof Error ? err.message : "Failed to fetch hazard data.";
      callbacks.onDataError?.(msg);
      const empty: HazardFeatureCollection = {
        type: "FeatureCollection",
        metadata: {
          generatedAt: Math.floor(Date.now() / 1000),
          totalFeatures: 0,
        },
        features: [],
      };
      return empty;
    });

  map.on("load", async () => {
    map.resize();
    const collection = await dataPromise;

    map.addSource("hazards", {
      type: "geojson",
      data: collection,
    });

    map.addLayer({
      id: "hazards-fill",
      type: "fill",
      source: "hazards",
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      layout: {
        "fill-sort-key": ["-", 0, ["coalesce", ["get", "areaSqKm"], 0]],
      },
      paint: {
        "fill-color": [
          "match",
          ["get", "domain"],
          "notam",
          "#ef4444",
          "maritime",
          "#3b82f6",
          "weather",
          "#f59e0b",
          "#94a3b8",
        ],
        "fill-opacity": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "areaSqKm"], 0],
          0,
          0.28,
          50000,
          0.2,
          500000,
          0.11,
        ],
      },
    });

    map.addLayer({
      id: "hazards-outline",
      type: "line",
      source: "hazards",
      filter: [
        "in",
        ["geometry-type"],
        ["literal", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]],
      ],
      paint: {
        "line-color": [
          "match",
          ["get", "domain"],
          "notam",
          "#f87171",
          "maritime",
          "#60a5fa",
          "weather",
          "#fbbf24",
          "#cbd5e1",
        ],
        "line-width": 1.8,
      },
    });

    map.addLayer({
      id: "hazards-points",
      type: "circle",
      source: "hazards",
      filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
      paint: {
        "circle-color": [
          "match",
          ["get", "domain"],
          "notam",
          "#ef4444",
          "maritime",
          "#38bdf8",
          "weather",
          [
            "match",
            ["get", "severity"],
            "danger",
            "#ef4444",
            "warning",
            "#f59e0b",
            "#10b981",
          ],
          "#94a3b8",
        ],
        "circle-radius": [
          "match",
          ["get", "domain"],
          "notam",
          6.5,
          "maritime",
          6.5,
          5.5,
        ],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#0f172a",
      },
    });

    applyMapFilters(map, latestCriteria);

    map.on("mousemove", (e: MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [...HAZARD_LAYERS],
      });
      if (hits.length === 0) {
        map.getCanvas().style.cursor = "";
        hoverPopup.remove();
        return;
      }

      map.getCanvas().style.cursor = "pointer";
      const topHit = pickMostSpecificHit(hits);
      const props = normalizeFeatureProperties(
        (topHit.properties ?? {}) as Record<string, unknown>
      );

      const tooltipEl = document.createElement("div");
      tooltipEl.className = "hover-tooltip-body";

      const badgeRow = document.createElement("div");
      badgeRow.className = "hover-tooltip-meta";
      badgeRow.textContent = `${props.subType} • ${props.issuer} • ${props.severity.toUpperCase()}`;

      const titleEl = document.createElement("div");
      titleEl.className = "hover-tooltip-title";
      titleEl.textContent = props.title;

      tooltipEl.append(badgeRow, titleEl);
      hoverPopup.setLngLat(e.lngLat).setDOMContent(tooltipEl).addTo(map);
    });

    map.on("mouseout", () => {
      map.getCanvas().style.cursor = "";
      hoverPopup.remove();
    });

    map.on("click", (e: MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [...HAZARD_LAYERS],
      });
      if (hits.length === 0) return;

      const selected = pickMostSpecificHit(hits);
      const props = normalizeFeatureProperties(
        (selected.properties ?? {}) as Record<string, unknown>
      );

      let coords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      if (selected.geometry.type === "Point") {
        coords = [
          selected.geometry.coordinates[0],
          selected.geometry.coordinates[1],
        ];
      }

      hoverPopup.remove();
      callbacks.onSelectFeature({
        properties: props,
        lngLat: coords,
      });
    });
  });

  return {
    map,
    updateFilters(criteria) {
      latestCriteria = {
        ...criteria,
        domains: [...criteria.domains],
        subTypes: [...criteria.subTypes],
        severities: [...criteria.severities],
      };
      applyMapFilters(map, latestCriteria);
    },
  };
}
