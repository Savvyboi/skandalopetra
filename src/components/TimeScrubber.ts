export interface TimeScrubberController {
  getTimestampSec: () => number;
  resetToLive: () => void;
}

const STEP_SEC = 900; // 15-minute increments
const SEVEN_DAYS_SEC = 7 * 86400;
const PLAY_ADVANCE_SEC = 3600; // +1 hour per tick
const PLAY_INTERVAL_MS = 250;
const LIVE_UPDATE_MS = 15_000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function timelineAnchor(timestampSec: number): number {
  return Math.floor(timestampSec / STEP_SEC) * STEP_SEC;
}

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
  if (diff === 0) return "Now";
  if (Math.abs(diff) < 60) return diff > 0 ? "+<1m" : "-<1m";
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
  let currentSec = nowSeconds();
  let isLive = true;
  const anchorNowSec = timelineAnchor(currentSec);
  let minSec = anchorNowSec - SEVEN_DAYS_SEC;
  let maxSec = anchorNowSec + SEVEN_DAYS_SEC;
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
  slider.value = String(anchorNowSec);

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
    const liveRefSec = nowSeconds();
    const utcStr = formatUtcTimestamp(currentSec);
    timestampReadout.textContent = utcStr;
    timestampReadout.dateTime = new Date(currentSec * 1000).toISOString();
    offsetReadout.textContent = isLive
      ? "Now"
      : formatRelativeOffset(currentSec, liveRefSec);

    const mode = isLive ? "live" : currentSec > liveRefSec ? "future" : "past";
    const modeLabels = {
      live: "LIVE NOW",
      future: "FUTURE FORECAST",
      past: "PAST ARCHIVE",
    };
    const modeLabel = modeLabels[mode];
    modeBadge.className = `mode-badge mode-${mode}`;
    slider.dataset.mode = mode;
    modeBadge.textContent = modeLabel;

    // Sync CSS custom properties for cross-browser slider fill (progress() + calc() fallback)
    slider.style.setProperty("--attr-min", String(minSec));
    slider.style.setProperty("--attr-max", String(maxSec));
    slider.style.setProperty("--control-value", slider.value);
    slider.setAttribute("aria-valuetext", `${utcStr} (${modeLabel})`);
  }

  function stopPlayback(): void {
    if (playTimer !== null) {
      window.clearInterval(playTimer);
      playTimer = null;
      setPlayButtonVisual(false);
    }
  }

  function setTimestamp(nextSec: number): void {
    isLive = false;
    currentSec = Math.max(minSec, Math.min(maxSec, nextSec));
    slider.value = String(currentSec);
    syncUi();
    onTimestampChange(currentSec);
  }

  slider.addEventListener("input", () => {
    stopPlayback();
    setTimestamp(slider.valueAsNumber);
  });

  playBtn.addEventListener("click", () => {
    if (playTimer !== null) {
      stopPlayback();
      return;
    }
    if (currentSec >= maxSec) {
      setTimestamp(minSec);
    } else if (isLive) {
      setTimestamp(timelineAnchor(currentSec));
    }
    setPlayButtonVisual(true);
    playTimer = window.setInterval(() => {
      const next = currentSec + PLAY_ADVANCE_SEC;
      if (next >= maxSec) {
        setTimestamp(maxSec);
        stopPlayback();
      } else {
        setTimestamp(next);
      }
    }, PLAY_INTERVAL_MS);
  });

  function updateLiveTime(): void {
    currentSec = nowSeconds();
    const anchor = timelineAnchor(currentSec);
    minSec = anchor - SEVEN_DAYS_SEC;
    maxSec = anchor + SEVEN_DAYS_SEC;
    slider.min = String(minSec);
    slider.max = String(maxSec);
    slider.value = String(anchor);
    syncUi();
    onTimestampChange(currentSec);
  }

  function resetToLive(): void {
    stopPlayback();
    isLive = true;
    updateLiveTime();
  }

  liveBtn.addEventListener("click", resetToLive);
  function tick(): void {
    if (document.hidden) return;
    if (isLive) updateLiveTime();
    else syncUi();
  }
  window.setInterval(tick, LIVE_UPDATE_MS);
  document.addEventListener("visibilitychange", tick);

  syncUi();

  return {
    getTimestampSec() {
      return isLive ? nowSeconds() : currentSec;
    },
    resetToLive,
  };
}
