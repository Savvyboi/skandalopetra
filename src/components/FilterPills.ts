import type {
  HazardDomain,
  HazardFeature,
  HazardRegion,
  HazardSeverity,
  HazardSubType,
} from "../types/schema";

export type SizeFilterPreset =
  | "all"
  | "no-giant"
  | "point"
  | "local"
  | "regional"
  | "large";

export type DurationFilterPreset = "all" | "short" | "medium" | "long";

export interface FilterPillsState {
  domains: Set<HazardDomain>;
  subTypes: Set<HazardSubType>;
  severities: Set<HazardSeverity>;
  region: HazardRegion | "all";
  issuer: string;
  sizePreset: SizeFilterPreset;
  recencyHours: number; // 0 = any time
  durationPreset: DurationFilterPreset;
  searchQuery: string;
}

export interface FilterPillsController {
  updateStats: (stats: {
    visibleCount: number;
    totalCount: number;
    generatedAtSec?: number;
    errorMessage?: string;
  }) => void;
  populateIssuers: (features: HazardFeature[]) => void;
  getState: () => FilterPillsState;
}

const ALL_DOMAINS: HazardDomain[] = ["notam", "maritime", "weather"];
const ALL_SUBTYPES: HazardSubType[] = [
  "NOTAM",
  "TFR",
  "NAVAREA",
  "NAVTEX",
  "SIGMET",
  "METAR",
  "TAF",
];
const ALL_SEVERITIES: HazardSeverity[] = ["danger", "warning", "info"];

const DOMAIN_OPTIONS: Array<{
  id: HazardDomain;
  label: string;
  dotClass: string;
}> = [
  { id: "notam", label: "Aviation NOTAMs", dotClass: "dot-notam" },
  { id: "maritime", label: "Maritime Warnings", dotClass: "dot-maritime" },
  { id: "weather", label: "Weather / SIGMET", dotClass: "dot-weather" },
];

const SEVERITY_OPTIONS: Array<{
  id: HazardSeverity;
  label: string;
  pillClass: string;
}> = [
  { id: "danger", label: "Danger", pillClass: "sev-pill-danger" },
  { id: "warning", label: "Warning", pillClass: "sev-pill-warning" },
  { id: "info", label: "Info", pillClass: "sev-pill-info" },
];

const REGION_OPTIONS: Array<{ value: HazardRegion | "all"; label: string }> = [
  { value: "all", label: "All Global Regions" },
  { value: "Europe", label: "Europe" },
  { value: "Middle East", label: "Middle East" },
  { value: "Africa", label: "Africa" },
  { value: "Asia", label: "Asia" },
  { value: "Oceania", label: "Oceania & Pacific" },
  { value: "North America", label: "North America & Caribbean" },
  { value: "South America", label: "South America" },
  { value: "High Seas", label: "High Seas / Polar" },
];

const SIZE_OPTIONS: Array<{ value: SizeFilterPreset; label: string }> = [
  { value: "all", label: "All Footprint Sizes" },
  { value: "no-giant", label: "Hide Giant Boxes (≤ 200k km²)" },
  { value: "point", label: "Pinpoint / Station (< 10 km²)" },
  { value: "local", label: "Local Area (10 – 1,000 km²)" },
  { value: "regional", label: "Regional (1k – 50k km²)" },
  { value: "large", label: "Large Sector (> 50k km²)" },
];

const RECENCY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "0", label: "Any Issue Time" },
  { value: "3", label: "Issued ≤ 3 hours ago" },
  { value: "12", label: "Issued ≤ 12 hours ago" },
  { value: "24", label: "Issued ≤ 24 hours ago" },
  { value: "72", label: "Issued ≤ 3 days ago" },
  { value: "168", label: "Issued ≤ 7 days ago" },
];

const DURATION_OPTIONS: Array<{ value: DurationFilterPreset; label: string }> = [
  { value: "all", label: "Any Effective Duration" },
  { value: "short", label: "Short-Term (< 6h)" },
  { value: "medium", label: "Daily / Tactical (6h – 48h)" },
  { value: "long", label: "Multi-Day / Standing (> 48h)" },
];

function formatShortUtc(sec: number): string {
  const d = new Date(sec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

function countNonDefaultAdvancedFilters(state: FilterPillsState): number {
  let active = 0;
  if (state.subTypes.size < ALL_SUBTYPES.length) active++;
  if (state.region !== "all") active++;
  if (state.issuer !== "all") active++;
  if (state.sizePreset !== "all") active++;
  if (state.recencyHours > 0) active++;
  if (state.durationPreset !== "all") active++;
  return active;
}

function isAnyFilterModified(state: FilterPillsState): boolean {
  return (
    state.domains.size < ALL_DOMAINS.length ||
    state.severities.size < ALL_SEVERITIES.length ||
    state.searchQuery.trim().length > 0 ||
    countNonDefaultAdvancedFilters(state) > 0
  );
}

function makeLabeledSelect(
  id: string,
  name: string,
  labelText: string,
  options: Array<{ value: string; label: string }>
): { wrapper: HTMLDivElement; select: HTMLSelectElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "filter-field";

  const label = document.createElement("label");
  label.htmlFor = id;
  label.className = "filter-field-label";
  label.textContent = labelText;

  const select = document.createElement("select");
  select.id = id;
  select.name = name;
  select.className = "filter-select";

  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    select.appendChild(o);
  }

  wrapper.append(label, select);
  return { wrapper, select };
}

export function initFilterPills(
  mount: HTMLElement,
  onChange: (state: FilterPillsState) => void
): FilterPillsController {
  const state: FilterPillsState = {
    domains: new Set<HazardDomain>(ALL_DOMAINS),
    subTypes: new Set<HazardSubType>(ALL_SUBTYPES),
    severities: new Set<HazardSeverity>(ALL_SEVERITIES),
    region: "all",
    issuer: "all",
    sizePreset: "all",
    recencyHours: 0,
    durationPreset: "all",
    searchQuery: "",
  };

  const panel = document.createElement("div");
  panel.className = "glass-panel filter-panel";

  // 1. Brand & feed telemetry header
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

  // 2. Search box inside semantic <search> landmark
  const searchLandmark = document.createElement("search");
  searchLandmark.className = "search-box";

  const searchLabel = document.createElement("label");
  searchLabel.htmlFor = "hazard-search-input";
  searchLabel.className = "visually-hidden";
  searchLabel.textContent =
    "Filter hazards by ICAO code, country, authority, NAVAREA ID, or keyword";

  const searchIcon = document.createElement("span");
  searchIcon.className = "search-icon";
  searchIcon.setAttribute("aria-hidden", "true");
  searchIcon.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.id = "hazard-search-input";
  searchInput.name = "q";
  searchInput.className = "search-input";
  searchInput.placeholder =
    "Search ICAO (LGGG, EGTT, RJTT), country, issuer, keyword…";
  searchInput.setAttribute("autocorrect", "off");
  searchInput.setAttribute("autocapitalize", "off");
  searchInput.spellcheck = false;

  searchLandmark.append(searchLabel, searchIcon, searchInput);

  // 3. Domain toggles
  const domainGroup = document.createElement("div");
  domainGroup.className = "pill-section";
  domainGroup.setAttribute("role", "group");
  domainGroup.setAttribute("aria-label", "Filter by hazard domain");

  const domainButtons = new Map<HazardDomain, HTMLButtonElement>();
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
      notifyChange();
    });
    domainButtons.set(opt.id, btn);
    domainGroup.appendChild(btn);
  }

  // 4. Severity toggles + Reset button
  const severityRow = document.createElement("div");
  severityRow.className = "pill-section severity-row";
  severityRow.setAttribute("role", "group");
  severityRow.setAttribute("aria-label", "Filter by severity level");

  const sevLabel = document.createElement("span");
  sevLabel.className = "section-micro-label";
  sevLabel.textContent = "Severity";
  severityRow.appendChild(sevLabel);

  const severityButtons = new Map<HazardSeverity, HTMLButtonElement>();
  for (const sev of SEVERITY_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `filter-pill filter-pill-sm ${sev.pillClass}`;
    btn.setAttribute("aria-pressed", "true");
    btn.textContent = sev.label;

    btn.addEventListener("click", () => {
      if (state.severities.has(sev.id)) {
        state.severities.delete(sev.id);
        btn.setAttribute("aria-pressed", "false");
      } else {
        state.severities.add(sev.id);
        btn.setAttribute("aria-pressed", "true");
      }
      notifyChange();
    });
    severityButtons.set(sev.id, btn);
    severityRow.appendChild(btn);
  }

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "reset-filters-btn";
  resetBtn.textContent = "Reset";
  resetBtn.hidden = true;
  severityRow.appendChild(resetBtn);

  // 5. Collapsible <details> disclosure for Size, Time, Issuer, Region, Sub-Type
  const detailsEl = document.createElement("details");
  detailsEl.className = "advanced-filters";

  const summaryEl = document.createElement("summary");
  summaryEl.className = "advanced-filters-summary";

  const summaryLabelWrap = document.createElement("span");
  summaryLabelWrap.className = "summary-label-wrap";

  const summaryTitle = document.createElement("span");
  summaryTitle.textContent = "More Filters (Region, Issuer, Size, Time)";

  const activeBadge = document.createElement("span");
  activeBadge.className = "advanced-active-badge";
  activeBadge.hidden = true;

  summaryLabelWrap.append(summaryTitle, activeBadge);
  summaryEl.appendChild(summaryLabelWrap);

  const detailsBody = document.createElement("div");
  detailsBody.className = "advanced-filters-body";

  // 5a. Sub-type multi-toggle pills
  const subTypeWrap = document.createElement("div");
  subTypeWrap.className = "subtype-block";

  const subTypeLabel = document.createElement("span");
  subTypeLabel.className = "filter-field-label";
  subTypeLabel.textContent = "Product Type";

  const subTypeGroup = document.createElement("div");
  subTypeGroup.className = "pill-section";
  subTypeGroup.setAttribute("role", "group");
  subTypeGroup.setAttribute("aria-label", "Filter by bulletin sub-type");

  const subTypeButtons = new Map<HazardSubType, HTMLButtonElement>();
  for (const st of ALL_SUBTYPES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-pill filter-pill-xs";
    btn.setAttribute("aria-pressed", "true");
    btn.textContent = st;
    btn.addEventListener("click", () => {
      if (state.subTypes.has(st)) {
        state.subTypes.delete(st);
        btn.setAttribute("aria-pressed", "false");
      } else {
        state.subTypes.add(st);
        btn.setAttribute("aria-pressed", "true");
      }
      notifyChange();
    });
    subTypeButtons.set(st, btn);
    subTypeGroup.appendChild(btn);
  }
  subTypeWrap.append(subTypeLabel, subTypeGroup);

  // 5b. 2-column labeled <select> controls
  const selectGrid = document.createElement("div");
  selectGrid.className = "advanced-select-grid";

  const regionCtrl = makeLabeledSelect(
    "filter-region-select",
    "region",
    "Region / Ocean",
    REGION_OPTIONS
  );
  const issuerCtrl = makeLabeledSelect(
    "filter-issuer-select",
    "issuer",
    "Who Issued (Authority)",
    [{ value: "all", label: "All Issuing Authorities" }]
  );
  const sizeCtrl = makeLabeledSelect(
    "filter-size-select",
    "size",
    "Footprint Size",
    SIZE_OPTIONS
  );
  const recencyCtrl = makeLabeledSelect(
    "filter-recency-select",
    "recency",
    "Issued Recency",
    RECENCY_OPTIONS
  );
  const durationCtrl = makeLabeledSelect(
    "filter-duration-select",
    "duration",
    "Hazard Duration",
    DURATION_OPTIONS
  );
  durationCtrl.wrapper.classList.add("filter-field-span-full");

  selectGrid.append(
    regionCtrl.wrapper,
    issuerCtrl.wrapper,
    sizeCtrl.wrapper,
    recencyCtrl.wrapper,
    durationCtrl.wrapper
  );

  detailsBody.append(subTypeWrap, selectGrid);
  detailsEl.append(summaryEl, detailsBody);

  function syncIndicators(): void {
    const advCount = countNonDefaultAdvancedFilters(state);
    if (advCount > 0) {
      activeBadge.textContent = `${advCount} active`;
      activeBadge.hidden = false;
    } else {
      activeBadge.hidden = true;
    }
    resetBtn.hidden = !isAnyFilterModified(state);
  }

  function notifyChange(): void {
    syncIndicators();
    onChange(state);
  }

  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    notifyChange();
  });

  regionCtrl.select.addEventListener("change", () => {
    state.region = regionCtrl.select.value as HazardRegion | "all";
    notifyChange();
  });

  issuerCtrl.select.addEventListener("change", () => {
    state.issuer = issuerCtrl.select.value;
    notifyChange();
  });

  sizeCtrl.select.addEventListener("change", () => {
    state.sizePreset = sizeCtrl.select.value as SizeFilterPreset;
    notifyChange();
  });

  recencyCtrl.select.addEventListener("change", () => {
    state.recencyHours = parseInt(recencyCtrl.select.value, 10) || 0;
    notifyChange();
  });

  durationCtrl.select.addEventListener("change", () => {
    state.durationPreset = durationCtrl.select.value as DurationFilterPreset;
    notifyChange();
  });

  resetBtn.addEventListener("click", () => {
    state.domains = new Set(ALL_DOMAINS);
    state.subTypes = new Set(ALL_SUBTYPES);
    state.severities = new Set(ALL_SEVERITIES);
    state.region = "all";
    state.issuer = "all";
    state.sizePreset = "all";
    state.recencyHours = 0;
    state.durationPreset = "all";
    state.searchQuery = "";

    searchInput.value = "";
    regionCtrl.select.value = "all";
    issuerCtrl.select.value = "all";
    sizeCtrl.select.value = "all";
    recencyCtrl.select.value = "0";
    durationCtrl.select.value = "all";

    for (const btn of domainButtons.values()) {
      btn.setAttribute("aria-pressed", "true");
    }
    for (const btn of severityButtons.values()) {
      btn.setAttribute("aria-pressed", "true");
    }
    for (const btn of subTypeButtons.values()) {
      btn.setAttribute("aria-pressed", "true");
    }

    notifyChange();
  });

  panel.append(header, searchLandmark, domainGroup, severityRow, detailsEl);
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
        ? ` • ${formatShortUtc(generatedAtSec)}`
        : "";
      statsEl.textContent = `${visibleCount.toLocaleString()} shown / ${totalCount.toLocaleString()} total${updatedSuffix}`;
    },
    populateIssuers(features) {
      const counts = new Map<string, number>();
      for (const f of features) {
        const iss = f.properties.issuer?.trim();
        if (!iss) continue;
        counts.set(iss, (counts.get(iss) ?? 0) + 1);
      }

      const sorted = Array.from(counts.entries()).sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      );

      const previousValue = state.issuer;
      issuerCtrl.select.replaceChildren();

      const allOpt = document.createElement("option");
      allOpt.value = "all";
      allOpt.textContent = `All Authorities (${sorted.length})`;
      issuerCtrl.select.appendChild(allOpt);

      for (const [issuerName, count] of sorted) {
        const opt = document.createElement("option");
        opt.value = issuerName;
        opt.textContent = `${issuerName} (${count})`;
        issuerCtrl.select.appendChild(opt);
      }

      if (previousValue !== "all" && counts.has(previousValue)) {
        issuerCtrl.select.value = previousValue;
      } else {
        state.issuer = "all";
        issuerCtrl.select.value = "all";
      }
    },
    getState() {
      return state;
    },
  };
}
