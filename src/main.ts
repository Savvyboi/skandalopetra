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

function countVisibleFeatures(
  features: HazardFeature[],
  criteria: MapFilterCriteria
): number {
  const q = criteria.searchQuery.trim().toUpperCase();
  const domainSet = new Set(criteria.domains);
  const subTypeSet = new Set(criteria.subTypes);
  const sevSet = new Set(criteria.severities);
  const minIssuedSec =
    criteria.recencyHours > 0
      ? criteria.referenceNowSec - criteria.recencyHours * 3600
      : 0;

  let count = 0;

  for (const feat of features) {
    const p = feat.properties;
    if (!domainSet.has(p.domain)) continue;
    if (!subTypeSet.has(p.subType)) continue;
    if (!sevSet.has(p.severity)) continue;
    if (p.validFrom > criteria.timestampSec || p.validTo < criteria.timestampSec) {
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

    if (q.length > 0) {
      const inTitle = (p.title ?? "").toUpperCase().includes(q);
      const inStation = (p.stationOrArea ?? "").toUpperCase().includes(q);
      const inIssuer = (p.issuer ?? "").toUpperCase().includes(q);
      const inCountry = (p.country ?? "").toUpperCase().includes(q);
      const inRaw = (p.rawText ?? "").toUpperCase().includes(q);
      if (!inTitle && !inStation && !inIssuer && !inCountry && !inRaw) continue;
    }

    count++;
  }

  return count;
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

  const drawer = initDetailDrawer(drawerMount);

  let syncAllFilters = () => {};

  const pills = initFilterPills(pillsMount, () => {
    syncAllFilters();
  });

  const scrubber = initTimeScrubber(scrubberMount, () => {
    syncAllFilters();
  });

  const initialCriteria = toMapCriteria(
    scrubber.getTimestampSec(),
    Math.floor(Date.now() / 1000),
    pills.getState()
  );

  const mapController = initMapCanvas(mapEl, initialCriteria, {
    onSelectFeature(selection) {
      drawer.open(selection);
    },
    onDataLoaded(collection) {
      loadedCollection = collection;
      pills.populateIssuers(collection.features);
      syncAllFilters();
    },
    onDataError(message) {
      pills.updateStats({
        visibleCount: 0,
        totalCount: 0,
        errorMessage: message,
      });
    },
  });

  syncAllFilters = () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const ts = scrubber.getTimestampSec();
    const criteria = toMapCriteria(ts, nowSec, pills.getState());
    mapController.updateFilters(criteria);

    if (loadedCollection) {
      const visibleCount = countVisibleFeatures(
        loadedCollection.features,
        criteria
      );
      pills.updateStats({
        visibleCount,
        totalCount: loadedCollection.features.length,
        generatedAtSec: loadedCollection.metadata?.generatedAt,
      });
    }
  };
}

bootstrap();
