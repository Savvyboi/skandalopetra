import type { HazardDomain, HazardSeverity } from "../types/schema";

export interface FilterPillsState {
  domains: Set<HazardDomain>;
  severities: Set<HazardSeverity>;
  searchQuery: string;
}

export interface FilterPillsController {
  updateStats: (stats: {
    visibleCount: number;
    totalCount: number;
    generatedAtSec?: number;
    errorMessage?: string;
  }) => void;
  getState: () => FilterPillsState;
}

const DOMAIN_OPTIONS: Array<{
  id: HazardDomain;
  label: string;
  dotClass: string;
}> = [
  { id: "notam", label: "Aviation NOTAMs", dotClass: "dot-notam" },
  { id: "maritime", label: "Maritime NAVAREA", dotClass: "dot-maritime" },
  { id: "weather", label: "Weather / SIGMET / TAF", dotClass: "dot-weather" },
];

const SEVERITY_OPTIONS: Array<{
  id: HazardSeverity;
  label: string;
  pillClass: string;
  defaultActive: boolean;
}> = [
  {
    id: "danger",
    label: "Danger",
    pillClass: "sev-pill-danger",
    defaultActive: true,
  },
  {
    id: "warning",
    label: "Warning",
    pillClass: "sev-pill-warning",
    defaultActive: true,
  },
  {
    id: "info",
    label: "Info",
    pillClass: "sev-pill-info",
    defaultActive: false,
  },
];

function formatShortUtc(sec: number): string {
  const d = new Date(sec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export function initFilterPills(
  mount: HTMLElement,
  onChange: (state: FilterPillsState) => void
): FilterPillsController {
  const state: FilterPillsState = {
    domains: new Set<HazardDomain>(["notam", "maritime", "weather"]),
    severities: new Set<HazardSeverity>(["danger", "warning"]),
    searchQuery: "",
  };

  const panel = document.createElement("div");
  panel.className = "glass-panel filter-panel";

  // Brand & feed telemetry header
  const header = document.createElement("div");
  header.className = "filter-header";

  const brandGroup = document.createElement("div");
  brandGroup.className = "brand-group";

  const brandMark = document.createElement("span");
  brandMark.className = "brand-mark";
  brandMark.setAttribute("aria-hidden", "true");
  brandMark.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8"/></svg>`;

  const brandTitle = document.createElement("span");
  brandTitle.className = "brand-title";
  brandTitle.textContent = "Global Hazard Tracker";

  brandGroup.append(brandMark, brandTitle);

  const statsEl = document.createElement("div");
  statsEl.className = "feed-stats";
  statsEl.textContent = "Loading global feed…";

  header.append(brandGroup, statsEl);

  // Search box inside semantic <search> landmark
  const searchLandmark = document.createElement("search");
  searchLandmark.className = "search-box";

  const searchLabel = document.createElement("label");
  searchLabel.htmlFor = "hazard-search-input";
  searchLabel.className = "visually-hidden";
  searchLabel.textContent =
    "Filter hazards by ICAO code, NAVAREA ID, or keyword";

  const searchIcon = document.createElement("span");
  searchIcon.className = "search-icon";
  searchIcon.setAttribute("aria-hidden", "true");
  searchIcon.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.id = "hazard-search-input";
  searchInput.className = "search-input";
  searchInput.placeholder = "Search ICAO (KJFK, EFHK), NAVAREA, keyword…";
  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    onChange(state);
  });

  searchLandmark.append(searchLabel, searchIcon, searchInput);

  // Domain toggles
  const domainGroup = document.createElement("div");
  domainGroup.className = "pill-section";
  domainGroup.setAttribute("role", "group");
  domainGroup.setAttribute("aria-label", "Filter by hazard domain");

  for (const opt of DOMAIN_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-pill";
    btn.setAttribute("aria-pressed", "true");

    const dot = document.createElement("span");
    dot.className = `pill-dot ${opt.dotClass}`;
    dot.setAttribute("aria-hidden", "true");

    const txt = document.createElement("span");
    txt.textContent = opt.label;

    btn.append(dot, txt);
    btn.addEventListener("click", () => {
      if (state.domains.has(opt.id)) {
        state.domains.delete(opt.id);
        btn.setAttribute("aria-pressed", "false");
      } else {
        state.domains.add(opt.id);
        btn.setAttribute("aria-pressed", "true");
      }
      onChange(state);
    });
    domainGroup.appendChild(btn);
  }

  // Severity toggles
  const severityRow = document.createElement("div");
  severityRow.className = "pill-section severity-row";
  severityRow.setAttribute("role", "group");
  severityRow.setAttribute("aria-label", "Filter by severity level");

  const sevLabel = document.createElement("span");
  sevLabel.className = "section-micro-label";
  sevLabel.textContent = "Severity";
  severityRow.appendChild(sevLabel);

  for (const sev of SEVERITY_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `filter-pill filter-pill-sm ${sev.pillClass}`;
    btn.setAttribute("aria-pressed", sev.defaultActive ? "true" : "false");
    btn.textContent = sev.label;

    btn.addEventListener("click", () => {
      if (state.severities.has(sev.id)) {
        state.severities.delete(sev.id);
        btn.setAttribute("aria-pressed", "false");
      } else {
        state.severities.add(sev.id);
        btn.setAttribute("aria-pressed", "true");
      }
      onChange(state);
    });
    severityRow.appendChild(btn);
  }

  panel.append(header, searchLandmark, domainGroup, severityRow);
  mount.replaceChildren(panel);

  return {
    updateStats({ visibleCount, totalCount, generatedAtSec, errorMessage }) {
      if (errorMessage) {
        statsEl.textContent = errorMessage;
        statsEl.dataset.error = "true";
        return;
      }
      delete statsEl.dataset.error;
      const updatedSuffix = generatedAtSec
        ? ` • Feed ${formatShortUtc(generatedAtSec)}`
        : "";
      statsEl.textContent = `${visibleCount.toLocaleString()} active / ${totalCount.toLocaleString()} cached${updatedSuffix}`;
    },
    getState() {
      return state;
    },
  };
}
