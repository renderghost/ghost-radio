const STORAGE_KEYS = {
  theme: "ghost-radio:theme",
  index: "ghost-radio:index",
};

const state = {
  stations: [],
  currentIndex: 0,
  playing: false,
  status: "idle", // idle | connecting | playing | error
  theme: "system", // light | dark | system
};

const audio = document.getElementById("audio");

// Real Web Audio frequency analysis. Most internet radio streams don't send
// CORS headers, so we try loading with crossOrigin="anonymous" (required for
// the analyser to read sample data) and silently fall back to a plain load
// (audio still plays, but the bars stay flat — no data available) if that
// fails. See loadStream() and handleStreamFailure().
const VISUALIZER = {
  bandCount: 32, // number of bars
  maxHeightPx: 64, // keep in sync with --viz-max-height in styles.css
  minHeightPx: 2, // keep in sync with --viz-min-height in styles.css
  fftSize: 2048, // analyser resolution (frequencyBinCount = fftSize / 2)
  smoothing: 0.8, // AnalyserNode.smoothingTimeConstant (0-1, higher = gentler)
};

const STATUS_LABELS = {
  idle: "Off Air",
  connecting: "Connecting…",
  playing: "On Air",
  error: "Signal Lost",
};

const els = {
  statusLabel: document.getElementById("status-label"),
  stationCounter: document.getElementById("station-counter"),
  stationName: document.getElementById("station-name"),
  displayMeta: document.getElementById("display-meta"),
  btnPlay: document.getElementById("btn-play"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  visualizer: document.getElementById("visualizer"),
  themeButtons: document.querySelectorAll("[data-theme-choice]"),
};

const CONNECT_TIMEOUT_MS = 15000; // give up on a silently-stuck "connecting" stream after this long

// Reassigning `audio.src` mid-stream can make the *previous*, now-abandoned
// live stream report a trailing "error"/"stalled" after the new one has
// already started loading (a known quirk with indefinite Icecast/SHOUTcast
// streams, worse on Safari/iOS) — and since it's the same shared <audio>
// element, whichever listener is currently attached receives it, with no way
// to tell which stream it was really about. An error/stalled event arriving
// this soon after starting a load is almost certainly that stale echo, not a
// real failure of the new one, so we ignore it.
const STALE_EVENT_GRACE_MS = 300;

let visualizerBars = [];
let visualizerFrame = null;
let bandRanges = [];
let audioCtx = null;
let analyser = null;
let freqData = null;
let usingCors = true;
let currentLoadController = null; // detaches the previous load's listeners the instant a new one starts
let connectTimeoutId = null;
let loadStartedAt = 0;

init();

async function init() {
  loadThemePreference();
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });

  state.stations = await loadStations();

  const savedIndex = Number(localStorage.getItem(STORAGE_KEYS.index));
  if (Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < state.stations.length) {
    state.currentIndex = savedIndex;
  }

  buildVisualizer();
  bindEvents();
  bindMediaSession();
  bindKeyboardShortcuts();
  render();
}

async function loadStations() {
  try {
    const res = await fetch("stations.json");
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("not an array");
    return data.filter((s) => s && typeof s.title === "string" && typeof s.streamUrl === "string");
  } catch {
    return [];
  }
}

function bindEvents() {
  els.btnPlay.addEventListener("click", togglePlay);
  els.btnPrev.addEventListener("click", () => changeStation(-1));
  els.btnNext.addEventListener("click", () => changeStation(1));

  els.themeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice));
  });
}

function bindMediaSession() {
  if (!("mediaSession" in navigator)) return;

  const handlers = {
    play: () => { if (!state.playing) play(); },
    pause: () => { if (state.playing) stop(); },
    previoustrack: () => changeStation(-1),
    nexttrack: () => changeStation(1),
  };

  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // Action not supported by this browser — skip it.
    }
  }
}

function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.repeat) return; // ignore OS key-repeat from a held key
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")) return;

    switch (e.code) {
      case "Space":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        changeStation(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        changeStation(1);
        break;
    }
  });
}

function buildVisualizer() {
  els.visualizer.innerHTML = "";
  visualizerBars = Array.from({ length: VISUALIZER.bandCount }, () => {
    const bar = document.createElement("span");
    bar.className = "display__visualizer-bar";
    els.visualizer.appendChild(bar);
    return bar;
  });
}

function ensureAudioGraph() {
  if (audioCtx) return;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;

  audioCtx = new AudioContextCtor();
  const sourceNode = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = VISUALIZER.fftSize;
  analyser.smoothingTimeConstant = VISUALIZER.smoothing;

  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination); // required, or audio goes silent

  freqData = new Uint8Array(analyser.frequencyBinCount);
  bandRanges = buildBandRanges(analyser.frequencyBinCount, VISUALIZER.bandCount);
}

// Groups FFT bins into bandCount bands on a log scale, so low frequencies
// (which carry most perceptible variation) get more bars than the highs.
function buildBandRanges(binCount, bandCount) {
  const maxLog = Math.log10(binCount);
  const ranges = [];
  for (let i = 0; i < bandCount; i++) {
    const start = Math.floor(10 ** ((i / bandCount) * maxLog));
    const end = Math.floor(10 ** (((i + 1) / bandCount) * maxLog));
    ranges.push([Math.max(0, start), Math.max(start + 1, end)]);
  }
  return ranges;
}

function startVisualizer() {
  ensureAudioGraph();
  if (!analyser) return; // Web Audio unsupported — bars just stay at rest
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  if (visualizerFrame) return;
  runVisualizerFrame();
}

function stopVisualizer() {
  if (visualizerFrame) {
    cancelAnimationFrame(visualizerFrame);
    visualizerFrame = null;
  }
  visualizerBars.forEach((bar) => {
    bar.style.height = `${VISUALIZER.minHeightPx}px`;
  });
}

function runVisualizerFrame() {
  visualizerFrame = requestAnimationFrame(runVisualizerFrame);

  analyser.getByteFrequencyData(freqData);

  visualizerBars.forEach((bar, i) => {
    const [start, end] = bandRanges[i];
    let sum = 0;
    for (let b = start; b < end; b++) sum += freqData[b];
    const level = sum / (end - start) / 255; // 0..1
    const px = Math.round(
      VISUALIZER.minHeightPx + level * (VISUALIZER.maxHeightPx - VISUALIZER.minHeightPx)
    );
    bar.style.height = `${px}px`;
  });
}

function togglePlay() {
  if (state.stations.length === 0) return;
  state.playing ? stop() : play();
}

function play() {
  const station = state.stations[state.currentIndex];
  if (!station) return;
  state.playing = true;
  usingCors = true;
  loadStream(station.streamUrl);
  setStatus("connecting");
}

function loadStream(url) {
  // Detach the previous load's listeners/timeout *before* starting this one,
  // so a stalled/aborted old connection can never fire a stale event against
  // whatever station happens to be current by the time it lands (the bug
  // behind "errors when I press next/prev while a station is still loading").
  currentLoadController?.abort();
  clearTimeout(connectTimeoutId);

  const controller = new AbortController();
  currentLoadController = controller;
  const { signal } = controller;
  loadStartedAt = Date.now();

  // crossOrigin must be set before .src for it to take effect on this load.
  audio.crossOrigin = usingCors ? "anonymous" : null;
  audio.src = url;
  audio.load();

  audio.addEventListener("waiting", () => setStatus("connecting"), { signal });
  audio.addEventListener("playing", () => {
    clearTimeout(connectTimeoutId);
    setStatus("playing");
  }, { signal });
  audio.addEventListener("error", () => handleStreamFailure(url), { signal });
  audio.addEventListener("stalled", () => handleStreamFailure(url), { signal });

  connectTimeoutId = setTimeout(() => handleStreamFailure(url), CONNECT_TIMEOUT_MS);

  audio.play().catch(() => {
    // Real failures are surfaced via the "error"/"stalled" listeners above.
  });
}

function handleStreamFailure(url) {
  if (Date.now() - loadStartedAt < STALE_EVENT_GRACE_MS) return; // likely a stale echo — see STALE_EVENT_GRACE_MS above
  clearTimeout(connectTimeoutId);
  if (usingCors) {
    // Most streams don't send CORS headers. Retry once without it so
    // playback can still succeed — the visualizer just won't have data.
    usingCors = false;
    loadStream(url);
    return;
  }
  state.playing = false;
  setStatus("error");
}

function stop() {
  currentLoadController?.abort();
  currentLoadController = null;
  clearTimeout(connectTimeoutId);
  state.playing = false;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  setStatus("idle");
}

function changeStation(delta) {
  if (state.stations.length === 0) return;
  state.currentIndex = (state.currentIndex + delta + state.stations.length) % state.stations.length;
  localStorage.setItem(STORAGE_KEYS.index, String(state.currentIndex));
  state.playing ? play() : render();
}

function setStatus(status) {
  state.status = status;
  render();
}

function loadThemePreference() {
  const saved = localStorage.getItem(STORAGE_KEYS.theme);
  state.theme = saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem(STORAGE_KEYS.theme, theme);
  applyTheme();
}

function applyTheme() {
  const effective =
    state.theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : state.theme;
  document.documentElement.dataset.theme = effective;
  renderThemeButtons();
}

function render() {
  const station = state.stations[state.currentIndex];
  const hasStations = state.stations.length > 0;

  els.stationName.textContent = station ? station.title : "— NO SIGNAL —";
  els.stationName.classList.toggle("is-empty", !station);

  els.displayMeta.textContent = station?.location ?? "";
  els.statusLabel.textContent = STATUS_LABELS[state.status];
  els.stationCounter.textContent = hasStations
    ? `${state.currentIndex + 1} of ${state.stations.length}`
    : "";

  document.body.dataset.status = state.status;

  els.btnPlay.classList.toggle("is-playing", state.playing);
  els.btnPlay.setAttribute("aria-label", state.playing ? "Stop" : "Play");

  [els.btnPlay, els.btnPrev, els.btnNext].forEach((btn) => {
    btn.disabled = !hasStations;
  });

  state.playing ? startVisualizer() : stopVisualizer();

  updateMediaSessionState(station);
}

function updateMediaSessionState(station) {
  if (!("mediaSession" in navigator)) return;

  navigator.mediaSession.metadata = station
    ? new MediaMetadata({
        title: station.title,
        artist: station.location ?? "",
        album: "Ghost Radio",
      })
    : null;

  navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
}

function renderThemeButtons() {
  els.themeButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.themeChoice === state.theme);
  });
}
