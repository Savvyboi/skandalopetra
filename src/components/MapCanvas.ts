import {
  AttributionControl,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type {
  AlertFeatureProperties,
  HazardFeatureCollection,
} from "../types/schema";

const DEFAULT_REPO_FEED =
  "https://raw.githubusercontent.com/Savvyboi/skandalopetra/data-feed/alerts.geojson";

const HAZARD_LAYERS = [
  "hazards-points",
  "hazards-outline",
  "hazards-fill",
] as const;

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
  selectedTimestampSec: number,
  activeDomains: string[],
  activeSeverities: string[],
  searchQuery: string
): void {
  if (!map.getLayer("hazards-fill")) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseConditions: any[] = [
    ["in", ["get", "domain"], ["literal", activeDomains]],
    ["in", ["get", "severity"], ["literal", activeSeverities]],
    ["<=", ["get", "validFrom"], selectedTimestampSec],
    [">=", ["get", "validTo"], selectedTimestampSec],
  ];

  if (searchQuery.trim().length > 0) {
    const q = searchQuery.trim().toUpperCase();
    baseConditions.push([
      "any",
      ["in", q, ["upcase", ["coalesce", ["get", "title"], ""]]],
      ["in", q, ["upcase", ["coalesce", ["get", "stationOrArea"], ""]]],
      ["in", q, ["upcase", ["coalesce", ["get", "rawText"], ""]]],
    ]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const combinedFilter: any = ["all", ...baseConditions];

  map.setFilter("hazards-fill", [
    "all",
    ["==", ["geometry-type"], "Polygon"],
    combinedFilter,
  ]);
  map.setFilter("hazards-outline", [
    "all",
    ["in", ["geometry-type"], ["literal", ["Polygon", "LineString"]]],
    combinedFilter,
  ]);
  map.setFilter("hazards-points", [
    "all",
    ["==", ["geometry-type"], "Point"],
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

  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) continue;
      const json = (await res.json()) as HazardFeatureCollection;
      if (json && json.type === "FeatureCollection" && Array.isArray(json.features)) {
        return json;
      }
    } catch {
      // Try next candidate feed URL
    }
  }

  throw new Error("Unable to load hazard GeoJSON feed from remote or local cache.");
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

export function initMapCanvas(
  container: HTMLElement,
  initialFilterState: {
    timestampSec: number;
    domains: string[];
    severities: string[];
    searchQuery: string;
  },
  callbacks: MapCanvasCallbacks
): {
  map: MapLibreMap;
  updateFilters: (
    timestampSec: number,
    domains: string[],
    severities: string[],
    searchQuery: string
  ) => void;
} {
  let latestFilterState = { ...initialFilterState };

  const map = new MapLibreMap({
    container,
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [0, 25],
    zoom: 2.2,
    minZoom: 1.2,
    maxZoom: 16,
    attributionControl: false,
  });

  map.addControl(new AttributionControl({ compact: true }), "bottom-right");
  map.addControl(
    new NavigationControl({ showCompass: true, visualizePitch: false }),
    "top-right"
  );

  const hoverPopup = new Popup({
    closeButton: false,
    closeOnClick: false,
    maxWidth: "280px",
    offset: 12,
    className: "hazard-hover-popup",
  });

  const dataPromise = fetchHazardCollection();

  map.on("load", async () => {
    let collection: HazardFeatureCollection = {
      type: "FeatureCollection",
      metadata: {
        generatedAt: Math.floor(Date.now() / 1000),
        totalFeatures: 0,
      },
      features: [],
    };

    try {
      collection = await dataPromise;
      callbacks.onDataLoaded(collection);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to fetch hazard data.";
      callbacks.onDataError?.(msg);
    }

    map.addSource("hazards", {
      type: "geojson",
      data: collection,
    });

    map.addLayer({
      id: "hazards-fill",
      type: "fill",
      source: "hazards",
      filter: ["==", ["geometry-type"], "Polygon"],
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
        "fill-opacity": 0.22,
      },
    });

    map.addLayer({
      id: "hazards-outline",
      type: "line",
      source: "hazards",
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "LineString"]]],
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
        "line-width": 2,
      },
    });

    map.addLayer({
      id: "hazards-points",
      type: "circle",
      source: "hazards",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": [
          "match",
          ["get", "severity"],
          "danger",
          "#ef4444",
          "warning",
          "#f59e0b",
          "info",
          "#10b981",
          "#94a3b8",
        ],
        "circle-radius": 6,
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#0f172a",
      },
    });

    applyMapFilters(
      map,
      latestFilterState.timestampSec,
      latestFilterState.domains,
      latestFilterState.severities,
      latestFilterState.searchQuery
    );

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
      const topHit = hits[0];
      const props = normalizeFeatureProperties(
        (topHit.properties ?? {}) as Record<string, unknown>
      );

      const tooltipEl = document.createElement("div");
      tooltipEl.className = "hover-tooltip-body";

      const badgeRow = document.createElement("div");
      badgeRow.className = "hover-tooltip-meta";
      badgeRow.textContent = `${props.subType} • ${props.severity.toUpperCase()}`;

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

      const selected = hits[0];
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
    updateFilters(timestampSec, domains, severities, searchQuery) {
      latestFilterState = {
        timestampSec,
        domains: [...domains],
        severities: [...severities],
        searchQuery,
      };
      applyMapFilters(map, timestampSec, domains, severities, searchQuery);
    },
  };
}
