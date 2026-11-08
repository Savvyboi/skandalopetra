# AGENTS.md — Global Aviation, Maritime & Weather Hazard Tracker

## Current implementation and follow-up

The sections below describe the original design. The implementation keeps the static GitHub Pages architecture, scheduled ingestion, rolling seven-day archive, and MapLibre timeline. The checked-out `data-feed` commit is the archive input for publishing runs. Complete active snapshots retire withdrawn records while preserving history, and a run with zero usable upstream records stops before publishing.

Source expansion includes DECEA AISWEB for credentialed Brazilian domestic NOTAMs, Kystverket coastal and NAVAREA XIX warnings, Canadian Coast Guard coastal and Arctic notices, AWC Center Weather Advisories and Alaska AIRMETs, and selected NWS CAP alerts with published polygons. The [coverage and setup table](README.md#additional-official-coverage) describes each feed’s scope. The map uses an advancing UTC Live clock, a periodic feed check, and indexed timeline counts. Frame rates depend on the device and the amount of geometry loaded.

Remaining source work is to verify DECEA with provisioned credentials, onboard the successor FAA NOTAM Management Service, and resolve NWS zone-only alerts against authoritative zone boundaries. Model CONUS G-AIRMETs as forecast snapshots before including them on the continuous timeline.

Measure initial map load and scrubbing with a full seven days of data on mobile hardware. If payload growth warrants it, split the static feed into a small live index and time-partitioned archives. The ingestion job logs a size warning before the [GitHub single-file limit](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) is reached.

## 1. Project Overview & Core Constraints
You are building a 100% free, open-source, static web application hosted on **GitHub Pages** that visualizes global **Aviation NOTAMs/TFRs**, **Maritime Navigational Warnings (NAVAREAs)**, and **Aviation/Marine Weather Warnings (METARs, TAFs, SIGMETs)** across **Past (-7 days), Live (Now), and Future (+7 days)** timeframes.

### Architectural Rules
1. **Zero Backend Servers / Zero Paid APIs:** The frontend is a static bundle deployed to GitHub Pages. All upstream API fetching, decompression, coordinate regex parsing, and historical archiving run in a scheduled **GitHub Actions cron job** every 15 minutes.
2. **Git-Backed Data Feed (`data-feed` branch):** The ingestion script writes a unified `alerts.geojson` file and publishes it to an orphan branch named `data-feed` (`force_orphan: true`) so git history never bloats and frontend rebuilds are not triggered on every data update.
3. **Responsive Client-Side Temporal Scrubbing:** The frontend loads `alerts.geojson` into a MapLibre GL JS source, periodically checks for a newer snapshot, and uses style filters (`map.setFilter`) to scrub across past, live, and future timestamps.
4. **Resilient Fallbacks:** If an upstream API fails during a cron run, log a warning and retain existing cached records from the previous run rather than crashing the pipeline.

---

## 2. Tech Stack & Dependencies
* **Build Tool & Language:** Vite + Vanilla TypeScript (strict mode)
* **Map Engine:** `maplibre-gl` (using free Carto Dark Matter vector tiles: `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json`)
* **Spatial & Parsing Utilities (Node ingestion script):**
  * `@turf/circle` & `@turf/helpers` (converting point+radius NOTAMs into GeoJSON polygons)
  * `fast-xml-parser` (parsing NOAA AWC gzipped TAF XML caches)
  * `csv-parse` (parsing NOAA AWC gzipped METAR CSV caches)
  * Node.js built-in `node:zlib`, `node:fs/promises`, and `fetch` (Node 22+)
* **Dev Dependencies:** `tsx`, `typescript`, `vite`, `@types/geojson`

---

## 3. Repository Directory Structure
```text
.
├── .github/workflows/
│   ├── ingest-data.yml          # Cron (every 15m): fetches APIs, updates 'data-feed' branch
│   └── deploy-pages.yml         # Push to main: builds Vite app and deploys to GitHub Pages
├── public/
│   └── boundaries/
│       └── navareas.geojson     # Static polygons for the 21 global NAVAREAs (fallback geometry)
├── scripts/
│   ├── ingest.ts                # Main CLI orchestrator: fetch -> normalize -> merge -> prune
│   ├── parsers/
│   │   ├── awcWeather.ts        # NOAA AWC METAR, TAF, and International SIGMET parsers
│   │   ├── ngaMaritime.ts       # U.S. NGA MSI broadcast warning & DDM coordinate parser
│   │   └── faaNotam.ts          # FAA TFR & optional FAA NOTAM API parser
│   └── utils/
│       └── geometry.ts          # DDM regex, polygon ring closer, Q-line circle generator
├── src/
│   ├── types/
│   │   └── schema.ts            # Shared GeoJSON TypeScript interfaces
│   ├── components/
│   │   ├── MapCanvas.ts         # MapLibre initialization, layers, and 60fps time filtering
│   │   ├── FilterPills.ts       # Top-left floating domain, severity, and search controls
│   │   ├── TimeScrubber.ts      # Bottom -7d to +7d timeline slider, Play/Pause, Live button
│   │   └── DetailDrawer.ts      # Right slide-over inspector + on-demand Open-Meteo fetch
│   ├── style.css                # Clean dark-mode UI styles
│   └── main.ts                  # Application entry point & state coordinator
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 4. Unified Data Schema (`src/types/schema.ts`)
All ingestion parsers MUST normalize output into this exact GeoJSON schema:

```typescript
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
```

---

## 5. Upstream API Specifications & Ingestion Rules

Every `fetch` call in `scripts/` MUST include the header:
`User-Agent: GlobalHazardTracker/1.0 (+https://github.com)`

### 5.1 Weather Warnings (`scripts/parsers/awcWeather.ts`)
1. **International & U.S. SIGMETs (Live Polygons):**
   * Endpoints:
     * `https://aviationweather.gov/api/data/isigmet?format=geojson`
     * `https://aviationweather.gov/api/data/airsigmet?format=geojson`
   * Map each feature to `domain: "weather"`, `subType: "SIGMET"`.
   * Set `severity: "danger"` for volcanic ash (`VA`), tropical cyclones (`TC`), or severe turbulence/icing; otherwise `"warning"`.
   * Extract `validTimeFrom` and `validTimeTo` into Unix seconds (`validFrom`, `validTo`).

2. **Global METARs (Live Station Alerts):**
   * Endpoint: `https://aviationweather.gov/data/cache/metars.cache.csv.gz`
   * Decompress with `zlib.gunzipSync`. Skip metadata header lines until the CSV header row starting with `raw_text,station_id`.
   * **Crucial Size Filter:** Do NOT store routine VFR stations. Only emit a `Point` feature if ANY of the following hold:
     * `flight_category` is `"IFR"` or `"LIFR"`
     * `wind_gust_kt` >= 25 or `wind_speed_kt` >= 25
     * `wx_string` matches `/TS|SQ|FC|GR|FZRA|SN|FG|VA/`
   * Set `severity: "danger"` for `LIFR`, gusts >= 35 kt, or `TS`/`SQ`/`FC`/`FZRA`/`VA`; otherwise `"warning"`.
   * Set `validFrom = observation_time` (Unix sec) and `validTo = observation_time + 5400` (90 minutes).

3. **Global TAFs (Future Weather Windows):**
   * Endpoint: `https://aviationweather.gov/data/cache/tafs.cache.xml.gz`
   * Decompress with `zlib.gunzipSync` and parse via `fast-xml-parser`.
   * Iterate over each `<TAF>` and its `<forecast>` sub-blocks.
   * Emit a `Point` feature (`subType: "TAF"`) ONLY for forecast sub-blocks predicting ceiling < 1000 ft AGL, visibility < 3 SM, wind gusts >= 25 kt, or hazardous `wx_string` (`TS`, `FZRA`, `SN`, `FG`, `SQ`, `GR`).
   * Use the sub-block's `<fcst_time_from>` and `<fcst_time_to>` as `validFrom` and `validTo` so future weather hazards appear when the user scrubs forward in time.

### 5.2 Maritime Navigational Warnings (`scripts/parsers/ngaMaritime.ts`)
1. **U.S. NGA MSI Broadcast Warnings:**
   * Endpoint: `https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=active`
   * Map each warning to `domain: "maritime"`, `subType: "NAVAREA"`.
   * Parse `issueDate` into `issuedAt` and `validFrom`.
   * Parse `validTo` from explicit cancellation directives in `text` (e.g., `CANCEL THIS MSG 141800Z NOV 26`). If no cancellation timestamp is present, set `validTo = now + 7 * 86400` so active open-ended warnings remain visible across the future slider.
   * Set `severity: "danger"` if `text` matches `/HAZARDOUS|ROCKET|MISSILE|GUNNERY|MINE|DERELICT|PIRACY|TSUNAMI|UNEXPLODED/i`, else `"warning"`.
   * Extract geometry using `parseNgaCoordinates(warning.text)`. If 0 coordinates are found in the text, look up the corresponding NAVAREA polygon from `public/boundaries/navareas.geojson` by matching `warning.navArea`.

### 5.3 Aviation NOTAMs & TFRs (`scripts/parsers/faaNotam.ts`)
1. **Unauthenticated FAA TFR Feed:**
   * Fetch active Temporary Flight Restrictions from `https://tfr.faa.gov/tfrapi/exportTfrList`.
   * Map items to `domain: "notam"`, `subType: "TFR"`, `severity: "danger"`.
2. **Optional Authenticated FAA NOTAM API:**
   * If `process.env.FAA_CLIENT_ID` and `process.env.FAA_CLIENT_SECRET` are populated, query `https://external-api.faa.gov/notamapi/v1/notams?responseFormat=geoJson&pageSize=1000`.
   * Extract ICAO Q-line circles or inline polygon vertices, mapping `effectiveStart` -> `validFrom` and `effectiveEnd` -> `validTo`.

---

## 6. Coordinate & Timestamp Parsers (`scripts/utils/geometry.ts`)
Implement these exact utility functions for coordinate extraction and geometry synthesis:

```typescript
import circle from "@turf/circle";
import type { Geometry } from "geojson";

/**
 * Extracts Degrees-Decimal-Minutes coordinates from NGA / NAVTEX message text.
 * Matches patterns like: 58-12.5N 019-30.0E or 12-34.56S 123-45.67W
 */
export function parseNgaCoordinates(rawText: string): [number, number][] {
  const ddmRegex =
    /(\d{1,2})-(\d{2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{2}(?:\.\d+)?)\s*([EW])/gi;
  const coords: [number, number][] = [];
  let match: RegExpExecArray | null;

  while ((match = ddmRegex.exec(rawText)) !== null) {
    const latDeg = parseInt(match[1], 10);
    const latMin = parseFloat(match[2]);
    const latHem = match[3].toUpperCase();
    const lonDeg = parseInt(match[4], 10);
    const lonMin = parseFloat(match[5]);
    const lonHem = match[6].toUpperCase();

    let lat = latDeg + latMin / 60;
    let lon = lonDeg + lonMin / 60;
    if (latHem === "S") lat = -lat;
    if (lonHem === "W") lon = -lon;

    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      coords.push([Number(lon.toFixed(5)), Number(lat.toFixed(5))]);
    }
  }
  return coords;
}

/**
 * Converts extracted coordinate pairs into Point, LineString, or closed Polygon.
 */
export function coordsToGeoJsonGeometry(
  coords: [number, number][]
): Geometry | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) {
    return { type: "Point", coordinates: coords[0] };
  }
  if (coords.length === 2) {
    return { type: "LineString", coordinates: coords };
  }

  const ring = [...coords];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push(first);
  }
  return { type: "Polygon", coordinates: [ring] };
}

/**
 * Parses an ICAO NOTAM Q-line coordinate/radius token (e.g., "5128N00027W005")
 * into a 32-vertex GeoJSON Polygon (radius in Nautical Miles).
 */
export function parseNotamQLineCircle(qCoordToken: string): Geometry | null {
  const match = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3})$/.exec(
    qCoordToken.trim()
  );
  if (!match) return null;

  let lat = parseInt(match[1], 10) + parseInt(match[2], 10) / 60;
  if (match[3] === "S") lat = -lat;

  let lon = parseInt(match[4], 10) + parseInt(match[5], 10) / 60;
  if (match[6] === "W") lon = -lon;

  const radiusNm = parseInt(match[7], 10);
  if (radiusNm <= 0 || radiusNm >= 999) {
    return { type: "Point", coordinates: [Number(lon.toFixed(5)), Number(lat.toFixed(5))] };
  }

  const radiusKm = radiusNm * 1.852;
  const poly = circle([lon, lat], radiusKm, { steps: 32, units: "kilometers" });
  return poly.geometry;
}

/**
 * Extracts "CANCEL THIS MSG DDHHMMZ MON YY" into a Unix timestamp in seconds.
 */
export function parseNgaCancelTimestamp(rawText: string): number | null {
  const match =
    /CANCEL\s+THIS\s+MSG\s+(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{2})/i.exec(
      rawText
    );
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const hour = parseInt(match[2], 10);
  const minute = parseInt(match[3], 10);
  const monthStr = match[4].toUpperCase();
  const year = 2000 + parseInt(match[5], 10);

  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const month = months[monthStr];
  if (month === undefined) return null;

  return Math.floor(Date.UTC(year, month, day, hour, minute, 0) / 1000);
}
```

---

## 7. Rolling 7-Day Archive & Merger (`scripts/ingest.ts`)
1. Determine `now = Math.floor(Date.now() / 1000)` and `sevenDaysAgo = now - 7 * 86400`.
2. Attempt to fetch the previous archive from `https://raw.githubusercontent.com/${process.env.REPO_OWNER_AND_NAME}/data-feed/alerts.geojson`. If the branch does not exist yet (404), initialize an empty `Map<string, HazardFeature>()`.
3. Load existing features into the `Map` keyed by `feature.properties.id`.
4. Run all parsers (`awcWeather`, `ngaMaritime`, `faaNotam`) via `Promise.allSettled`.
5. Upsert newly fetched features into the `Map` by `properties.id`.
6. Filter the merged values: discard any feature where `feature.properties.validTo < sevenDaysAgo`.
7. Write the resulting `HazardFeatureCollection` JSON to `./dist-data/alerts.geojson`.

---

## 8. MapLibre GL JS Temporal Filter (`src/components/MapCanvas.ts`)
1. Initialize `maplibregl.Map` with `style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"`, centered at `[0, 25]`, zoom `2.2`.
2. Load the GeoJSON feed URL:
   * In production, fetch `https://raw.githubusercontent.com/<owner>/<repo>/data-feed/alerts.geojson` (or configure via `import.meta.env.VITE_DATA_FEED_URL` with fallback to `./alerts.geojson`).
3. Add 3 layers sourced from `"hazards"`:
   * `hazards-fill` (`type: "fill"`, `filter: ["==", ["geometry-type"], "Polygon"]`)
     * Color by `domain`: `"notam"` -> `#ef4444` (Red), `"maritime"` -> `#3b82f6` (Blue), `"weather"` -> `#f59e0b` (Amber). `fill-opacity: 0.22`.
   * `hazards-outline` (`type: "line"`, `filter: ["in", ["geometry-type"], ["literal", ["Polygon", "LineString"]]]`)
     * Color by `domain`: `"notam"` -> `#f87171`, `"maritime"` -> `#60a5fa`, `"weather"` -> `#fbbf24`. `line-width: 2`.
   * `hazards-points` (`type: "circle"`, `filter: ["==", ["geometry-type"], "Point"]`)
     * Color by `severity`: `"danger"` -> `#ef4444`, `"warning"` -> `#f59e0b`, `"info"` -> `#10b981`. `circle-radius: 6`, `circle-stroke-width: 1.5`, `circle-stroke-color: "#0f172a"`.
4. Apply MapLibre style filters when the timeline slider or domain/severity pills change:

```typescript
export function applyMapFilters(
  map: maplibregl.Map,
  selectedTimestampSec: number,
  activeDomains: string[],
  activeSeverities: string[],
  searchQuery: string
) {
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
```

---

## 9. UI & Navigation Layout Specification
Build a clean, dark-mode glassmorphic overlay system (`backdrop-filter: blur(12px)`, `background: rgba(15, 23, 42, 0.85)`, `border: 1px solid rgba(255, 255, 255, 0.12)`) floating above the full-viewport map:

1. **Top-Left Floating Pill Bar (`src/components/FilterPills.ts`):**
   * **Domain Toggles:** `Aviation NOTAMs` (Red dot), `Maritime NAVAREA` (Blue dot), `Weather / SIGMET / TAF` (Amber dot). All active by default.
   * **Severity Toggles:** `Danger` and `Warning` active by default.
   * **Quick Search Input:** Filters visible map features by ICAO code (e.g., `EFHK`, `KJFK`), NAVAREA ID, or keyword in real time.
2. **Bottom Temporal Scrubber (`src/components/TimeScrubber.ts`):**
   * Range input (`<input type="range">`) with `min = now - 7 * 86400`, `max = now + 7 * 86400`, `step = 900` (15-minute increments).
   * Displays formatted UTC timestamp (`YYYY-MM-DD HH:mm UTC`) and a dynamic mode badge: `PAST ARCHIVE` (slate), `LIVE NOW` (pulsing green), or `FUTURE FORECAST` (purple).
   * Includes a **Play / Pause** button that advances the slider by 1 hour every 250ms, plus a **Reset to Live** button.
3. **Right-Side Slide-Over Inspector (`src/components/DetailDrawer.ts`):**
   * Opens when clicking any map feature (`hazards-fill`, `hazards-outline`, or `hazards-points`).
   * Displays: `title`, color-coded `domain` and `severity` badges, `validFrom` to `validTo` UTC window, altitude limits (if present), and the verbatim `rawText` inside a styled `<pre>` block.
   * **On-Demand Open-Meteo Marine Integration:** When a user clicks a `"maritime"` feature, extract the clicked `[lon, lat]` and fetch `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_direction,wave_period&hourly=wave_height&forecast_days=3` directly in the browser to display live wave height, swell period, and peak 72-hour forecast wave height inside the drawer.

---

## 10. GitHub Actions Workflows

### 10.1 `.github/workflows/ingest-data.yml`
```yaml
name: Update Global Hazard Feed

on:
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Run ingestion and archive merger
        env:
          FAA_CLIENT_ID: ${{ secrets.FAA_CLIENT_ID }}
          FAA_CLIENT_SECRET: ${{ secrets.FAA_CLIENT_SECRET }}
          REPO_OWNER_AND_NAME: ${{ github.repository }}
        run: npx tsx scripts/ingest.ts

      - name: Publish GeoJSON to orphan data-feed branch
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist-data
          publish_branch: data-feed
          force_orphan: true
```

### 10.2 `.github/workflows/deploy-pages.yml`
```yaml
name: Deploy Frontend to GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: true

jobs:
  build-and-deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Build Vite frontend
        env:
          VITE_DATA_FEED_URL: "[https://raw.githubusercontent.com/$](https://raw.githubusercontent.com/$){{ github.repository }}/data-feed/alerts.geojson"
        run: npm run build

      - name: Setup Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: "./dist"

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

---

## 11. Step-by-Step Execution Checklist for the Agent
Execute these steps in order and verify each stage before proceeding:

1. **Scaffold & Configure:** Initialize `package.json` with scripts (`dev`, `build`, `typecheck`, `ingest`), configure `vite.config.ts` with `base: "./"` (so GitHub Pages asset paths resolve cleanly on project subpaths), and create `src/types/schema.ts`.
2. **Generate Static Fallback Boundaries:** Create `public/boundaries/navareas.geojson` containing simplified bounding polygons for the 21 global NAVAREAs (`I` through `XXI`) so coordinate-less maritime advisories always render on the map.
3. **Implement Parsers & Ingestion Pipeline:** Build `scripts/utils/geometry.ts`, the three domain parsers (`awcWeather.ts`, `ngaMaritime.ts`, `faaNotam.ts`), and `scripts/ingest.ts`. Also copy `./dist-data/alerts.geojson` to `./public/alerts.geojson` during local runs so `npm run dev` has immediate local data.
4. **Build Map & UI Components:** Implement `MapCanvas.ts`, `FilterPills.ts`, `TimeScrubber.ts`, `DetailDrawer.ts`, and wire them together in `src/main.ts` and `src/style.css`.
5. **Verify End-to-End:**
   * Run `npm run typecheck` (`tsc --noEmit`) and fix any TypeScript errors.
   * Run `npm run ingest` and confirm `./dist-data/alerts.geojson` is created with valid features across `"weather"`, `"maritime"`, and `"notam"` domains.
   * Run `npm run build` and verify the production bundle compiles cleanly into `./dist`.
