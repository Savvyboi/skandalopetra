import type { SelectedMapHazard } from "./MapCanvas";
import { formatUtcTimestamp } from "./TimeScrubber";

export interface DetailDrawerController {
  open: (hazard: SelectedMapHazard) => void;
  close: () => void;
}

interface OpenMeteoMarineResponse {
  current?: {
    wave_height?: number | null;
    wave_direction?: number | null;
    wave_period?: number | null;
  };
  hourly?: {
    wave_height?: Array<number | null>;
  };
}

function formatAltitudeRange(minFt?: number, maxFt?: number): string | null {
  if (minFt === undefined && maxFt === undefined) return null;
  const fmt = (ft: number) =>
    ft <= 0
      ? "SFC"
      : ft >= 60000
      ? "UNL"
      : ft >= 18000 && ft % 100 === 0
      ? `FL${Math.round(ft / 100)}`
      : `${ft.toLocaleString()} ft MSL`;

  if (minFt !== undefined && maxFt !== undefined) {
    return `${fmt(minFt)} – ${fmt(maxFt)}`;
  }
  if (minFt !== undefined) return `From ${fmt(minFt)}`;
  return `Up to ${fmt(maxFt!)}`;
}

function formatAreaSqKm(areaSqKm: number): string {
  if (!Number.isFinite(areaSqKm) || areaSqKm <= 0) {
    return "Point / Station";
  }
  if (areaSqKm < 10) {
    return `${areaSqKm.toFixed(1)} km²`;
  }
  return `${Math.round(areaSqKm).toLocaleString()} km²`;
}

function formatDurationHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "Instant / Point";
  if (hours < 24) return `${hours.toFixed(1)} hrs`;
  const days = hours / 24;
  return `${days.toFixed(1)} days (${Math.round(hours)}h)`;
}

export function initDetailDrawer(mount: HTMLElement): DetailDrawerController {
  let marineAbort: AbortController | null = null;

  const container = document.createElement("div");
  container.className = "glass-panel drawer-card";

  // Header
  const header = document.createElement("div");
  header.className = "drawer-header";

  const badgesWrap = document.createElement("div");
  badgesWrap.className = "drawer-badges";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "drawer-close-btn";
  closeBtn.setAttribute("aria-label", "Close hazard inspector");
  closeBtn.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

  header.append(badgesWrap, closeBtn);

  // Body
  const body = document.createElement("div");
  body.className = "drawer-body";

  const titleEl = document.createElement("h2");
  titleEl.className = "drawer-title";

  const metaGrid = document.createElement("dl");
  metaGrid.className = "drawer-meta-grid";

  const marineSection = document.createElement("div");
  marineSection.className = "marine-telemetry-box";
  marineSection.hidden = true;

  const rawLabel = document.createElement("h3");
  rawLabel.className = "drawer-section-heading";
  rawLabel.textContent = "Verbatim Bulletin";

  const preEl = document.createElement("pre");
  preEl.className = "bulletin-pre";
  preEl.tabIndex = 0;

  const codeEl = document.createElement("code");
  preEl.appendChild(codeEl);

  body.append(titleEl, metaGrid, marineSection, rawLabel, preEl);
  container.append(header, body);
  mount.replaceChildren(container);

  function close(): void {
    if (marineAbort) {
      marineAbort.abort();
      marineAbort = null;
    }
    mount.dataset.open = "false";
    mount.inert = true;
  }

  closeBtn.addEventListener("click", close);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mount.dataset.open === "true") {
      close();
    }
  });

  function addMetaItem(term: string, value: string): void {
    const row = document.createElement("div");
    row.className = "meta-item";
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    metaGrid.appendChild(row);
  }

  async function loadMarineConditions(lon: number, lat: number): Promise<void> {
    if (marineAbort) {
      marineAbort.abort();
    }
    const controller = new AbortController();
    marineAbort = controller;

    marineSection.hidden = false;
    marineSection.innerHTML = "";

    const sectionTitle = document.createElement("h3");
    sectionTitle.className = "drawer-section-heading marine-heading";
    sectionTitle.textContent = `Open-Meteo Marine Telemetry (${lat.toFixed(
      2
    )}°, ${lon.toFixed(2)}°)`;

    const statusLine = document.createElement("p");
    statusLine.className = "marine-status";
    statusLine.textContent = "Fetching live sea state & 72h wave forecast…";

    marineSection.append(sectionTitle, statusLine);

    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${encodeURIComponent(
      lat.toFixed(4)
    )}&longitude=${encodeURIComponent(
      lon.toFixed(4)
    )}&current=wave_height,wave_direction,wave_period&hourly=wave_height&forecast_days=3`;

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as OpenMeteoMarineResponse;
      if (controller.signal.aborted) return;

      const curHeight = data.current?.wave_height;
      const curPeriod = data.current?.wave_period;
      const curDir = data.current?.wave_direction;
      const hourlyWaves = (data.hourly?.wave_height ?? []).filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v)
      );
      const peak72h =
        hourlyWaves.length > 0 ? Math.max(...hourlyWaves) : null;

      if (
        (curHeight === null || curHeight === undefined) &&
        peak72h === null
      ) {
        statusLine.textContent =
          "No offshore wave grid cell at clicked coordinate (land/coastal mask). Click an open-water point inside this warning zone for live wave telemetry.";
        return;
      }

      statusLine.remove();

      const cards = document.createElement("div");
      cards.className = "marine-metrics";

      const makeMetric = (label: string, val: string, sub?: string) => {
        const card = document.createElement("div");
        card.className = "marine-metric-card";
        const k = document.createElement("span");
        k.className = "marine-metric-label";
        k.textContent = label;
        const v = document.createElement("strong");
        v.className = "marine-metric-value";
        v.textContent = val;
        card.append(k, v);
        if (sub) {
          const s = document.createElement("span");
          s.className = "marine-metric-sub";
          s.textContent = sub;
          card.appendChild(s);
        }
        return card;
      };

      cards.append(
        makeMetric(
          "Live Wave Height",
          curHeight !== null && curHeight !== undefined
            ? `${curHeight.toFixed(1)} m`
            : "—",
          curDir !== null && curDir !== undefined
            ? `Dir ${Math.round(curDir)}°`
            : undefined
        ),
        makeMetric(
          "Swell Period",
          curPeriod !== null && curPeriod !== undefined
            ? `${curPeriod.toFixed(1)} s`
            : "—"
        ),
        makeMetric(
          "72h Peak Wave",
          peak72h !== null ? `${peak72h.toFixed(1)} m` : "—"
        )
      );

      marineSection.appendChild(cards);
    } catch (err) {
      if (controller.signal.aborted) return;
      statusLine.textContent = `Marine wave telemetry unavailable (${
        err instanceof Error ? err.message : "network error"
      }).`;
    }
  }

  function open({ properties, lngLat }: SelectedMapHazard): void {
    badgesWrap.replaceChildren();

    const domainBadge = document.createElement("span");
    domainBadge.className = `badge badge-domain-${properties.domain}`;
    domainBadge.textContent = `${properties.domain.toUpperCase()} • ${
      properties.subType
    }`;

    const sevBadge = document.createElement("span");
    sevBadge.className = `badge badge-sev-${properties.severity}`;
    sevBadge.textContent = properties.severity.toUpperCase();

    badgesWrap.append(domainBadge, sevBadge);

    if (properties.stationOrArea) {
      const stationBadge = document.createElement("span");
      stationBadge.className = "badge badge-station";
      stationBadge.textContent = properties.stationOrArea;
      badgesWrap.appendChild(stationBadge);
    }

    titleEl.textContent = properties.title;

    metaGrid.replaceChildren();
    addMetaItem("Issued By", properties.issuer || "Unknown Authority");
    addMetaItem(
      "Country / Region",
      `${properties.country || "Global"} (${properties.region || "Global"})`
    );
    addMetaItem("Footprint Size", formatAreaSqKm(properties.areaSqKm));
    addMetaItem("Duration", formatDurationHours(properties.durationHours));
    addMetaItem("Effective From", formatUtcTimestamp(properties.validFrom));
    addMetaItem("Effective Until", formatUtcTimestamp(properties.validTo));
    addMetaItem("Issued At", formatUtcTimestamp(properties.issuedAt));

    const altStr = formatAltitudeRange(
      properties.altitudeMinFt,
      properties.altitudeMaxFt
    );
    if (altStr) {
      addMetaItem("Altitude Limits", altStr);
    }

    addMetaItem(
      "Coordinates",
      `${lngLat[1].toFixed(3)}°, ${lngLat[0].toFixed(3)}°`
    );

    codeEl.textContent = properties.rawText || "No raw bulletin text provided.";

    if (properties.domain === "maritime") {
      void loadMarineConditions(lngLat[0], lngLat[1]);
    } else {
      if (marineAbort) {
        marineAbort.abort();
        marineAbort = null;
      }
      marineSection.hidden = true;
      marineSection.replaceChildren();
    }

    mount.inert = false;
    mount.dataset.open = "true";
    closeBtn.focus();
  }

  return { open, close };
}
