import "./style.css";
import type { HazardFeature, HazardFeatureCollection } from "./types/schema";
import { initDetailDrawer } from "./components/DetailDrawer";
import { initFilterPills, type FilterPillsState } from "./components/FilterPills";
import { initMapCanvas } from "./components/MapCanvas";
import { initTimeScrubber } from "./components/TimeScrubber";

function countVisibleFeatures(
  features: HazardFeature[],
  timestampSec: number,
  filterState: FilterPillsState
): number {
  const q = filterState.searchQuery.trim().toUpperCase();
  let count = 0;

  for (const feat of features) {
    const p = feat.properties;
    if (!filterState.domains.has(p.domain)) continue;
    if (!filterState.severities.has(p.severity)) continue;
    if (p.validFrom > timestampSec || p.validTo < timestampSec) continue;

    if (q.length > 0) {
      const inTitle = (p.title ?? "").toUpperCase().includes(q);
      const inStation = (p.stationOrArea ?? "").toUpperCase().includes(q);
      const inRaw = (p.rawText ?? "").toUpperCase().includes(q);
      if (!inTitle && !inStation && !inRaw) continue;
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
    throw new Error("Required application mount elements missing from index.html");
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

  const initialPills = pills.getState();
  const initialTimestamp = scrubber.getTimestampSec();

  const mapController = initMapCanvas(
    mapEl,
    {
      timestampSec: initialTimestamp,
      domains: Array.from(initialPills.domains),
      severities: Array.from(initialPills.severities),
      searchQuery: initialPills.searchQuery,
    },
    {
      onSelectFeature(selection) {
        drawer.open(selection);
      },
      onDataLoaded(collection) {
        loadedCollection = collection;
        refreshStats();
      },
      onDataError(message) {
        pills.updateStats({
          visibleCount: 0,
          totalCount: 0,
          errorMessage: message,
        });
      },
    }
  );

  function refreshStats(): void {
    if (!loadedCollection) return;
    const state = pills.getState();
    const ts = scrubber.getTimestampSec();
    const visibleCount = countVisibleFeatures(
      loadedCollection.features,
      ts,
      state
    );
    pills.updateStats({
      visibleCount,
      totalCount: loadedCollection.features.length,
      generatedAtSec: loadedCollection.metadata?.generatedAt,
    });
  }

  syncAllFilters = () => {
    const state = pills.getState();
    const ts = scrubber.getTimestampSec();
    mapController.updateFilters(
      ts,
      Array.from(state.domains),
      Array.from(state.severities),
      state.searchQuery
    );
    refreshStats();
  };
}

bootstrap();
