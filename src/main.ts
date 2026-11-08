import "./style.css";
import type { HazardFeature, HazardFeatureCollection } from "./types/schema";
import { initDetailDrawer } from "./components/DetailDrawer";
import {
  initFilterPills,
  type FilterPillsState,
} from "./components/FilterPills";
import {
  initMapCanvas,
  type MapFilterCriteria,
} from "./components/MapCanvas";
import { initTimeScrubber } from "./components/TimeScrubber";

function toMapCriteria(
  timestampSec: number,
  referenceNowSec: number,
  state: FilterPillsState
): MapFilterCriteria {
  return {
    timestampSec,
    referenceNowSec,
    domains: Array.from(state.domains),
    subTypes: Array.from(state.subTypes),
    severities: Array.from(state.severities),
    region: state.region,
    issuer: state.issuer,
    sizePreset: state.sizePreset,
    recencyHours: state.recencyHours,
    durationPreset: state.durationPreset,
    searchQuery: state.searchQuery,
  };
}

function matchingTimeBounds(
  features: HazardFeature[],
  criteria: MapFilterCriteria
): { starts: number[]; ends: number[] } {
  const q = criteria.searchQuery.trim().toUpperCase();
  const domainSet = new Set(criteria.domains);
  const subTypeSet = new Set(criteria.subTypes);
  const sevSet = new Set(criteria.severities);
  const minIssuedSec =
    criteria.recencyHours > 0
      ? criteria.referenceNowSec - criteria.recencyHours * 3600
      : 0;

  const starts: number[] = [];
  const ends: number[] = [];

  for (const feat of features) {
    const p = feat.properties;
    if (!domainSet.has(p.domain)) continue;
    if (!subTypeSet.has(p.subType)) continue;
    if (!sevSet.has(p.severity)) continue;
    if (!Number.isFinite(p.validFrom) || !Number.isFinite(p.validTo) || p.validFrom > p.validTo) {
      continue;
    }

    if (criteria.region !== "all" && (p.region ?? "") !== criteria.region) {
      continue;
    }
    if (criteria.issuer !== "all" && (p.issuer ?? "") !== criteria.issuer) {
      continue;
    }

    const area = p.areaSqKm ?? 0;
    if (criteria.sizePreset === "no-giant" && area > 200000) continue;
    if (criteria.sizePreset === "point" && area >= 10) continue;
    if (criteria.sizePreset === "local" && (area < 10 || area > 1000)) continue;
    if (criteria.sizePreset === "regional" && (area <= 1000 || area > 50000)) {
      continue;
    }
    if (criteria.sizePreset === "large" && area <= 50000) continue;

    if (criteria.recencyHours > 0 && (p.issuedAt ?? 0) < minIssuedSec) {
      continue;
    }

    const dur = p.durationHours ?? 0;
    if (criteria.durationPreset === "short" && dur >= 6) continue;
    if (criteria.durationPreset === "medium" && (dur < 6 || dur > 48)) continue;
    if (criteria.durationPreset === "long" && dur <= 48) continue;

    if (
      q.length > 0 &&
      !(p.title ?? "").toUpperCase().includes(q) &&
      !(p.stationOrArea ?? "").toUpperCase().includes(q) &&
      !(p.issuer ?? "").toUpperCase().includes(q) &&
      !(p.country ?? "").toUpperCase().includes(q) &&
      !(p.rawText ?? "").toUpperCase().includes(q)
    ) continue;

    starts.push(p.validFrom);
    ends.push(p.validTo);
  }

  return {
    starts: starts.sort((a, b) => a - b),
    ends: ends.sort((a, b) => a - b),
  };
}

// Count started records minus expired records using sorted inclusive time bounds.
function countBefore(values: number[], cutoff: number): number {
  let start = 0;
  let end = values.length;
  while (start < end) {
    const mid = Math.floor((start + end) / 2);
    if (values[mid] < cutoff) start = mid + 1;
    else end = mid;
  }
  return start;
}

function bootstrap(): void {
  const mapEl = document.getElementById("map");
  const pillsMount = document.getElementById("filter-pills-mount");
  const scrubberMount = document.getElementById("time-scrubber-mount");
  const drawerMount = document.getElementById("detail-drawer-mount");

  if (!mapEl || !pillsMount || !scrubberMount || !drawerMount) {
    throw new Error(
      "Required application mount elements missing from index.html"
    );
  }

  let loadedCollection: HazardFeatureCollection | null = null;
  let feedError: string | undefined;
  let indexedCriteria = "";
  let indexedBounds = { starts: [] as number[], ends: [] as number[] };

  const drawer = initDetailDrawer(drawerMount);

  let syncFrame = 0;
  function scheduleSync(): void {
    if (syncFrame) return;
    syncFrame = window.requestAnimationFrame(syncAllFilters);
  }
  const pills = initFilterPills(pillsMount, scheduleSync);
  const scrubber = initTimeScrubber(scrubberMount, scheduleSync);

  const initialCriteria = toMapCriteria(
    scrubber.getTimestampSec(),
    Math.floor(Date.now() / 1000),
    pills.getState()
  );

  const mapController = initMapCanvas(mapEl, initialCriteria, {
    onSelectFeature(selections) {
      drawer.open(selections);
    },
    onDataLoaded(collection) {
      feedError = undefined;
      if (loadedCollection !== collection) {
        loadedCollection = collection;
        indexedCriteria = "";
        pills.populateIssuers(collection.features);
      }
      scheduleSync();
    },
    onDataError(message) {
      feedError = message;
      scheduleSync();
    },
    onBasemapUnavailable() {
      pills.showBasemapUnavailable();
    },
  });

  function syncAllFilters(): void {
    syncFrame = 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const ts = scrubber.getTimestampSec();
    const state = pills.getState();
    const referenceNow = Math.floor(nowSec / 60) * 60;
    const criteria = toMapCriteria(ts, referenceNow, state);
    mapController.updateFilters(criteria);

    if (loadedCollection) {
      const { timestampSec, referenceNowSec, ...matchingCriteria } = criteria;
      const cacheKey = JSON.stringify([
        matchingCriteria,
        state.recencyHours > 0 ? referenceNowSec : 0,
      ]);
      if (cacheKey !== indexedCriteria) {
        indexedBounds = matchingTimeBounds(loadedCollection.features, criteria);
        indexedCriteria = cacheKey;
      }
      const visibleCount =
        countBefore(indexedBounds.starts, timestampSec + 1) -
        countBefore(indexedBounds.ends, timestampSec);
      pills.updateStats({
        visibleCount,
        totalCount: loadedCollection.features.length,
        generatedAtSec: loadedCollection.metadata?.generatedAt,
        errorMessage: feedError ? "Refresh failed. Showing last loaded feed." : undefined,
      });
    } else if (feedError) {
      pills.updateStats({ visibleCount: 0, totalCount: 0, errorMessage: feedError });
    }
  }
}

bootstrap();
