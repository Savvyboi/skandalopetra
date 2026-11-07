export interface TimeScrubberController {
  getTimestampSec: () => number;
  resetToLive: () => void;
}

const STEP_SEC = 900; // 15-minute increments
const SEVEN_DAYS_SEC = 7 * 86400;
const PLAY_ADVANCE_SEC = 3600; // +1 hour per tick
const PLAY_INTERVAL_MS = 250;

export function formatUtcTimestamp(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

function formatRelativeOffset(targetSec: number, refSec: number): string {
  const diff = targetSec - refSec;
  if (Math.abs(diff) < STEP_SEC) return "Now";
  const sign = diff > 0 ? "+" : "-";
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const mins = Math.floor((abs % 3600) / 60);
  if (days > 0) {
    return `${sign}${days}d ${hours}h`;
  }
  if (hours > 0) {
    return mins > 0 ? `${sign}${hours}h ${mins}m` : `${sign}${hours}h`;
  }
  return `${sign}${mins}m`;
}

export function initTimeScrubber(
  mount: HTMLElement,
  onTimestampChange: (timestampSec: number) => void
): TimeScrubberController {
  const anchorNowSec =
    Math.floor(Date.now() / 1000 / STEP_SEC) * STEP_SEC;
  let minSec = anchorNowSec - SEVEN_DAYS_SEC;
  let maxSec = anchorNowSec + SEVEN_DAYS_SEC;
  let currentSec = anchorNowSec;
  let playTimer: number | null = null;

  const panel = document.createElement("div");
  panel.className = "glass-panel scrubber-panel";

  // Top row: mode badge, UTC readout, Play/Pause & Reset to Live buttons
  const topBar = document.createElement("div");
  topBar.className = "scrubber-top";

  const timeGroup = document.createElement("div");
  timeGroup.className = "scrubber-time-group";

  const modeBadge = document.createElement("span");
  modeBadge.className = "mode-badge mode-live";

  const timestampReadout = document.createElement("time");
  timestampReadout.className = "utc-readout";

  const offsetReadout = document.createElement("span");
  offsetReadout.className = "offset-readout";

  timeGroup.append(modeBadge, timestampReadout, offsetReadout);

  const controlsGroup = document.createElement("div");
  controlsGroup.className = "scrubber-actions";

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "scrubber-btn";
  playBtn.setAttribute("aria-pressed", "false");

  const setPlayButtonVisual = (playing: boolean) => {
    playBtn.setAttribute("aria-pressed", playing ? "true" : "false");
    playBtn.innerHTML = playing
      ? `<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><span>Pause</span>`
      : `<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z"/></svg><span>Play</span>`;
  };
  setPlayButtonVisual(false);

  const liveBtn = document.createElement("button");
  liveBtn.type = "button";
  liveBtn.className = "scrubber-btn scrubber-btn-live";
  liveBtn.innerHTML = `<span class="live-dot-inline" aria-hidden="true"></span><span>Reset to Live</span>`;

  controlsGroup.append(playBtn, liveBtn);
  topBar.append(timeGroup, controlsGroup);

  // Range slider row
  const sliderWrap = document.createElement("div");
  sliderWrap.className = "slider-wrap";

  const sliderLabel = document.createElement("label");
  sliderLabel.htmlFor = "hazard-timeline-slider";
  sliderLabel.className = "visually-hidden";
  sliderLabel.textContent =
    "Timeline scrubber (-7 days past archive to +7 days future forecast)";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.id = "hazard-timeline-slider";
  slider.className = "timeline-slider";
  slider.min = String(minSec);
  slider.max = String(maxSec);
  slider.step = String(STEP_SEC);
  slider.value = String(currentSec);

  const ticksRow = document.createElement("div");
  ticksRow.className = "scrubber-ticks";
  ticksRow.setAttribute("aria-hidden", "true");
  ticksRow.innerHTML = `
    <span>-7d Archive</span>
    <span>-3d</span>
    <span class="tick-center">LIVE (Now)</span>
    <span>+3d</span>
    <span>+7d Forecast</span>
  `;

  sliderWrap.append(sliderLabel, slider, ticksRow);
  panel.append(topBar, sliderWrap);
  mount.replaceChildren(panel);

  function syncUi(): void {
    const liveRefSec =
      Math.floor(Date.now() / 1000 / STEP_SEC) * STEP_SEC;
    const utcStr = formatUtcTimestamp(currentSec);
    timestampReadout.textContent = utcStr;
    timestampReadout.dateTime = new Date(currentSec * 1000).toISOString();
    offsetReadout.textContent = formatRelativeOffset(currentSec, liveRefSec);

    let modeLabel = "LIVE NOW";
    if (currentSec < liveRefSec - STEP_SEC) {
      modeLabel = "PAST ARCHIVE";
      modeBadge.className = "mode-badge mode-past";
      slider.dataset.mode = "past";
    } else if (currentSec > liveRefSec + STEP_SEC) {
      modeLabel = "FUTURE FORECAST";
      modeBadge.className = "mode-badge mode-future";
      slider.dataset.mode = "future";
    } else {
      modeLabel = "LIVE NOW";
      modeBadge.className = "mode-badge mode-live";
      slider.dataset.mode = "live";
    }
    modeBadge.textContent = modeLabel;

    // Sync CSS custom properties for cross-browser slider fill (progress() + calc() fallback)
    slider.style.setProperty("--attr-min", String(minSec));
    slider.style.setProperty("--attr-max", String(maxSec));
    slider.style.setProperty("--control-value", String(currentSec));
    slider.setAttribute("aria-valuetext", `${utcStr} (${modeLabel})`);
  }

  function stopPlayback(): void {
    if (playTimer !== null) {
      window.clearInterval(playTimer);
      playTimer = null;
      setPlayButtonVisual(false);
    }
  }

  function setTimestamp(nextSec: number, emit = true): void {
    currentSec = Math.max(minSec, Math.min(maxSec, nextSec));
    slider.value = String(currentSec);
    syncUi();
    if (emit) {
      onTimestampChange(currentSec);
    }
  }

  slider.addEventListener("input", () => {
    stopPlayback();
    setTimestamp(Number(slider.value), true);
  });

  playBtn.addEventListener("click", () => {
    if (playTimer !== null) {
      stopPlayback();
      return;
    }
    if (currentSec >= maxSec) {
      setTimestamp(minSec, true);
    }
    setPlayButtonVisual(true);
    playTimer = window.setInterval(() => {
      const next = currentSec + PLAY_ADVANCE_SEC;
      if (next > maxSec) {
        setTimestamp(maxSec, true);
        stopPlayback();
      } else {
        setTimestamp(next, true);
      }
    }, PLAY_INTERVAL_MS);
  });

  function resetToLive(): void {
    stopPlayback();
    const freshNow = Math.floor(Date.now() / 1000 / STEP_SEC) * STEP_SEC;
    minSec = freshNow - SEVEN_DAYS_SEC;
    maxSec = freshNow + SEVEN_DAYS_SEC;
    slider.min = String(minSec);
    slider.max = String(maxSec);
    setTimestamp(freshNow, true);
  }

  liveBtn.addEventListener("click", resetToLive);

  syncUi();

  return {
    getTimestampSec() {
      return currentSec;
    },
    resetToLive,
  };
}
