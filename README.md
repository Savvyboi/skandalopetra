# Skandalopetra — Global Aviation, Maritime & Weather Hazard Tracker

A zero-backend, zero-paid-API, open-source static web application hosted on **GitHub Pages** that visualizes global **Aviation NOTAMs/TFRs**, **Maritime Navigational Warnings (NAVAREAs)**, and **Aviation/Marine Weather Warnings (SIGMETs, METARs, TAFs)** across **Past (-7 days), Live (Now), and Future (+7 days)** timeframes.

## Architecture

1. **Scheduled GitHub Actions Ingestion (`.github/workflows/ingest-data.yml`):**
   - Runs every 15 minutes on Node.js 22.
   - Fetches, decompresses, and normalizes:
     - **Global ICAO Aviation NOTAMs & U.S. FAA TFRs:** Worldwide ICAO Q-line NOTAMs across Europe, Middle East, Africa, Asia-Pacific, Oceania, Canada (`NAV CANADA CFPS`), Latin America, and North Atlantic FIRs (`FAA Global NOTAM Search` + optional authenticated `FAA External NOTAM API`), alongside GeoServer WFS polygons + verbatim FDC text for U.S. Temporary Flight Restrictions (`TFR`).
     - **Multi-Source Global Maritime Warnings (`NAVAREA` & `NAVTEX`):** Live global navigational and marine warnings aggregated concurrently from **UKHO Admiralty** (`NAVAREA I` & UK Coastal `WZ`), **Danish Maritime Authority Niord** (Baltic & North Sea GeoJSON), **Hellenic Navy Hydrographic Service — HNHS** (`NAVAREA III` Mediterranean/Aegean), **Japan Coast Guard JHOD** (`NAVAREA XI` & NW Pacific/SE Asia `NAVTEX`), **U.S. NGA MSI**, and **18 WMO/GTS High Seas & Marine Bulletins** (`NOAA OPC/NHC`, `DHN Brazil`, `SHN/SMN Argentina`, `DIRECTEMAR Chile`, `BoM Australia`, `MetService NZ`, `FMS Fiji`, `Météo-France NC`, and `JMA Japan`).
     - **NOAA Aviation Weather Center (AWC):** International & U.S. SIGMET polygons, global hazardous METAR observations (`IFR`/`LIFR`, winds/gusts ≥ 25 kt, or severe weather strings), and global TAF future forecast windows.
   - Enriches every feature with **Issuing Authority**, **Country / Ocean**, **Global Region**, **Spherical Footprint Area ($\text{km}^2$)**, and **Effective Duration (hours)**, merges into a rolling 7-day archive (`alerts.geojson`), and publishes to an orphan `data-feed` branch (`force_orphan: true`) so `main` commit history stays lean.
2. **60fps GPU-Filtered MapLibre Frontend (`src/`):**
   - Loads `alerts.geojson` once into a MapLibre GL JS source over Carto Dark Matter vector tiles.
   - Uses GPU expression filters (`map.setFilter`) to scrub smoothly across `-7d` archive, `Live` current hazards, and `+7d` forecast windows in 15-minute increments, plus instant client-side filtering by **Domain**, **Sub-Type** (`NOTAM`, `TFR`, `NAVAREA`, `NAVTEX`, `SIGMET`, `METAR`, `TAF`), **Severity**, **Global Region**, **Issuing Authority**, **Footprint Size**, **Issued Recency**, and **Duration**.
   - Sorts overlapping polygons smallest-on-top (`fill-sort-key` + specificity hit-testing) so pinpoint coastal/airspace hazards remain clickable inside regional advisories.
   - Fetches live wave height, swell period, and 72-hour peak wave forecasts on demand from **Open-Meteo Marine API** when inspecting maritime advisories.

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
3. *(Optional)* Add `FAA_CLIENT_ID` and `FAA_CLIENT_SECRET` under **Settings → Secrets and variables → Actions** to include authenticated FAA External NOTAM API records alongside the unauthenticated FAA TFR feed.
