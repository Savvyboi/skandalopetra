# Skandalopetra — Global Aviation, Maritime & Weather Hazard Tracker

A zero-backend, zero-paid-API, open-source static web application hosted on **GitHub Pages** that visualizes global **Aviation NOTAMs/TFRs**, **Maritime Navigational Warnings (NAVAREAs)**, and **Aviation/Marine Weather Warnings (SIGMETs, METARs, TAFs)** across **Past (-7 days), Live (Now), and Future (+7 days)** timeframes.

## Architecture

1. **Scheduled GitHub Actions Ingestion (`.github/workflows/ingest-data.yml`):**
   - Scheduled every 15 minutes on Node.js 22. Runs publish serially and read the previous archive from the actual `data-feed` branch before replacing it.
   - Fetches, decompresses, and normalizes:
     - **ICAO Aviation NOTAMs & U.S. FAA TFRs:** Selected FIR and airport notices from FAA public search and NAV CANADA CFPS, with request caps on public search. U.S. Temporary Flight Restrictions use FAA GeoServer WFS polygons and FDC bulletin text.
     - **Maritime warnings:** Navigational notices from **UKHO Admiralty**, **Danish Maritime Authority Niord**, **Hellenic Navy Hydrographic Service**, **Japan Coast Guard JHOD**, and **U.S. NGA MSI**. High-seas and marine meteorological bulletins use the separate `MARINE WEATHER` subtype.
     - **NOAA Aviation Weather Center (AWC):** International & U.S. SIGMET polygons, global hazardous METAR observations (`IFR`/`LIFR`, winds/gusts ≥ 25 kt, or severe weather strings), and global TAF future forecast windows.
   - Enriches every feature with **Issuing Authority**, **Country / Ocean**, **Global Region**, **Spherical Footprint Area ($\text{km}^2$)**, and **Effective Duration (hours)**, merges into a rolling 7-day archive (`alerts.geojson`), and publishes to an orphan `data-feed` branch (`force_orphan: true`) so `main` commit history stays lean.
2. **MapLibre Frontend (`src/`):**
   - Loads `alerts.geojson` into a MapLibre GL JS source over Carto Dark Matter vector tiles, checks for a newer feed while the tab is visible, and retains the last good copy during an outage.
   - Applies MapLibre style filters and indexes matching validity windows for timeline counts. Live mode follows UTC, and the archive and forecast slider moves in 15-minute steps. Filters include domain, subtype, severity, region, issuing authority, footprint size, issue time, and duration.
   - Sorts overlapping polygons smallest-on-top (`fill-sort-key` + specificity hit-testing) so pinpoint coastal/airspace hazards remain clickable inside regional advisories.
   - Fetches live wave height, swell period, and 72-hour peak wave forecasts on demand from **Open-Meteo Marine API** when inspecting maritime advisories.

## Additional official coverage

| Source | Coverage and scope |
| --- | --- |
| [DECEA AISWEB](https://ajuda.decea.mil.br/base-de-conhecimento/o-que-e-a-api-aisweb/) | Brazilian domestic NOTAMs issued in the past 90 days and returned as current by AISWEB. Requires approved API credentials. Displays the B/C validity envelope and preserves schedule D in the bulletin. |
| [Norwegian Coastal Administration](https://api.kystverket.no/openapi.json) | Norwegian coastal navigational warnings (`NAVWARN`) and NAVAREA XIX. Uses published GeoJSON, with coordinates extracted from the bulletin when available. |
| [Canadian Coast Guard](https://e-navigation.canada.ca/gn/description/eng/81398d73-f082-4036-ad26-4ab5d9be3f46) | Canadian navigational warnings (`NAVWARN`) and Arctic NAVAREAs XVII/XVIII. Multiple mapped locations for one notice are grouped into one record. |
| [NOAA Aviation Weather Center](https://aviationweather.gov/data/api/) | U.S. Center Weather Advisories (`CWA`) and Alaska `AIRMET` areas for the validity windows provided by AWC. |
| [NOAA National Weather Service](https://www.weather.gov/documentation/services-web-alerts) | Selected U.S. severe weather and marine CAP products (`NWS ALERT`) with an explicit warning polygon. Zone-only alerts are outside this adapter’s coverage. |

Canadian warning data is provided by the Canadian Coast Guard and Department of Fisheries and Oceans under the [Canadian Coast Guard Open Information Licence](https://www.canada.ca/en/canadian-coast-guard/corporate/publications/open-information-licence.html). The inspector links to the original notices.

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Fetch live global hazards into ./dist-data/alerts.geojson & ./public/alerts.geojson
npm run ingest

# 3. Start local Vite dev server
npm run dev

# 4. Run strict TypeScript check & production build
npm run typecheck
npm run build
```

## GitHub Pages & Optional Secrets Setup

1. In your GitHub repository (**Settings → Pages**), set **Build and deployment → Source** to **GitHub Actions**.
2. Trigger **Update Global Hazard Feed** (`ingest-data.yml`) once manually via the **Actions** tab (or wait up to 15 minutes for the cron schedule) to initialize the `data-feed` branch.
3. *(Optional)* Add `DECEA_API_KEY` and `DECEA_API_PASS` under **Settings → Secrets and variables → Actions** after [obtaining DECEA access](https://ajuda.decea.mil.br/base-de-conhecimento/o-que-e-a-api-aisweb/).
4. The legacy FAA External NOTAM adapter uses `FAA_CLIENT_ID` and `FAA_CLIENT_SECRET` where that service remains available. The successor [FAA NOTAM Management Service](https://www.faa.gov/about/initiatives/notam) requires separate onboarding.
