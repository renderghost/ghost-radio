const STORAGE_KEYS = {
  theme: "ghost-radio:theme",
  index: "ghost-radio:index",
};

const state = {
  stations: [],
  currentIndex: 0,
  playing: false,
  status: "idle", // idle | seeking | playing | error
  theme: "system", // light | dark | system
};

const audio = document.getElementById("audio");

// Real Web Audio frequency analysis, with a simulated fallback for when it
// can't get real data: most internet radio streams don't send CORS headers
// (see loadStream()/handleStreamFailure()), and some platforms (iOS, for any
// browser — they all run WebKit there) decode HLS (.m3u8) streams natively,
// bypassing Web Audio entirely. Either way the analyser reads all zeros, so
// runVisualizerFrame() probes for real data for a bit after each station
// loads and, if none shows up, switches to a stylised animation instead of
// leaving the bars dead flat.
const VISUALIZER = {
  bandCount: 128, // number of bars
  maxHeightPx: 128, // keep in sync with --viz-max-height in styles.css
  minHeightPx: 2, // keep in sync with --viz-min-height in styles.css
  fftSize: 2048, // analyser resolution (frequencyBinCount = fftSize / 2)
  smoothing: 0.8, // AnalyserNode.smoothingTimeConstant (0-1, higher = gentler)
  silentFramesBeforeFallback: 90, // ~1.5s at 60fps of all-zero data before giving up on real analysis
  fakeUpdateIntervalMs: 140, // how often the simulated fallback picks new target bar levels
};

const STATUS_LABELS = {
  idle: "Off Air",
  seeking: "Seeking",
  playing: "Live",
  error: "Signal Lost",
};

// Fetches for stations that opt in via a `nowPlaying` block in stations.json
// (see startNowPlaying() below). Every provider normalizes to
// { raw, artist, track }: `raw` is always the display string, `artist`/
// `track` are only set when the source gives them separately (or split
// cleanly on " - "). That split shape is intentional — it's the input a
// future Last.fm scrobble step would need — but nothing here scrobbles
// anything yet.
const NOW_PLAYING_PROVIDERS = {
  somafm: fetchSomaFmNowPlaying,
  radioco: fetchRadioCoNowPlaying,
  "icecast-json": fetchIcecastNowPlaying,
  azuracast: fetchAzuraCastNowPlaying,
};

const els = {
  statusLabel: document.getElementById("status-label"),
  stationCounter: document.getElementById("station-counter"),
  stationName: document.getElementById("station-name"),
  displayMeta: document.getElementById("display-meta"),
  btnPlay: document.getElementById("btn-play"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  btnCopy: document.getElementById("btn-copy"),
  btnCopyLabel: document.getElementById("btn-copy-label"),
  visualizer: document.getElementById("visualizer"),
  nowPlaying: document.getElementById("now-playing"),
  themeButtons: document.querySelectorAll("[data-theme-choice]"),
};

const COPIED_LABEL_MS = 1500; // how long the Copy button shows "Copied" before reverting

const CONNECT_TIMEOUT_MS = 10000; // give up on a silently-stuck "seeking" stream after this long

const NOW_PLAYING_POLL_MS = 15000; // how often to re-fetch now-playing metadata while a station plays

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
let visualizerMode = "idle"; // "idle" | "probing" | "real" | "fake"
let silentFrameCount = 0;
let fakeEnergy = 0.6;
let lastFakeTick = 0;
let bandRanges = [];
let audioCtx = null;
let analyser = null;
let freqData = null;
let usingCors = true;
let currentLoadController = null; // detaches the previous load's listeners the instant a new one starts
let connectTimeoutId = null;
let loadStartedAt = 0;
let nowPlayingPollTimeoutId = null;
let nowPlayingToken = 0; // bumped on every startNowPlaying()/stopNowPlaying() so a late fetch from an abandoned station can't render itself
let nowPlayingResizeBound = false;
let seekStartIndex = 0; // the first station tried this seek — wrapping back to it means every station is dead
let seekDirection = 1; // 1 = forward (next), -1 = backward (previous)

init();

async function init() {
  loadThemePreference();
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme();
  });

  state.stations = await loadStations();

  const urlIndex = getStationIndexFromUrl();
  if (urlIndex !== -1) {
    state.currentIndex = urlIndex;
  } else {
    const savedIndex = Number(localStorage.getItem(STORAGE_KEYS.index));
    if (Number.isInteger(savedIndex) && savedIndex >= 0 && savedIndex < state.stations.length) {
      state.currentIndex = savedIndex;
    }
  }
  updateUrl();

  buildVisualizer();
  bindEvents();
  bindMediaSession();
  bindKeyboardShortcuts();
  render();
}

function getStationIndexFromUrl() {
  const slug = new URLSearchParams(location.search).get("station");
  if (!slug) return -1;
  return state.stations.findIndex((s) => s.slug === slug);
}

// Keeps the URL's ?station= param in sync with the current station, via
// replaceState so switching stations doesn't spam browser history.
function updateUrl() {
  const station = state.stations[state.currentIndex];
  const url = new URL(location.href);
  if (station?.slug) {
    url.searchParams.set("station", station.slug);
  } else {
    url.searchParams.delete("station");
  }
  history.replaceState(null, "", url);
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
  els.btnCopy.addEventListener("click", copyShareUrl);

  els.themeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice));
  });
}

let copiedLabelTimeoutId = null;

async function copyShareUrl() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Clipboard API unavailable (no permission, insecure context, etc.) —
    // fall back to the legacy selection-based copy.
    const textarea = document.createElement("textarea");
    textarea.value = url;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch {
      // Give up silently — nothing more we can do here.
    }
    textarea.remove();
  }

  clearTimeout(copiedLabelTimeoutId);
  els.btnCopy.classList.add("is-copied");
  els.btnCopyLabel.textContent = "Copied";
  copiedLabelTimeoutId = setTimeout(() => {
    els.btnCopy.classList.remove("is-copied");
    els.btnCopyLabel.textContent = "Copy";
  }, COPIED_LABEL_MS);
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
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  // Only pick a starting mode when there isn't already a deliberate one (set
  // by play() or handleStreamFailure()) — this function may run again mid-
  // session (e.g. seeking -> playing) and must never clobber that choice.
  if (visualizerMode === "idle") {
    visualizerMode = analyser ? "probing" : "fake";
    silentFrameCount = 0;
  }
  if (visualizerFrame) return;
  runVisualizerFrame();
}

function stopVisualizer() {
  if (visualizerFrame) {
    cancelAnimationFrame(visualizerFrame);
    visualizerFrame = null;
  }
  visualizerMode = "idle";
  visualizerBars.forEach((bar) => setBarHeight(bar, 0));
}

function runVisualizerFrame(timestamp) {
  visualizerFrame = requestAnimationFrame(runVisualizerFrame);

  if (visualizerMode === "probing" || visualizerMode === "real") {
    analyser.getByteFrequencyData(freqData);
    let total = 0;
    for (let i = 0; i < freqData.length; i++) total += freqData[i];

    if (total > 0) {
      visualizerMode = "real";
      silentFrameCount = 0;
      renderRealLevels();
      return;
    }

    silentFrameCount += 1;
    if (silentFrameCount < VISUALIZER.silentFramesBeforeFallback) return; // hold at rest while probing
    visualizerMode = "fake"; // real analyser gave us nothing (CORS-tainted, HLS on iOS, etc.)
  }

  // Fake mode only picks new random targets periodically; the CSS transition
  // on each bar handles the gentle glide between them every frame in between.
  const now = timestamp ?? performance.now();
  if (now - lastFakeTick >= VISUALIZER.fakeUpdateIntervalMs) {
    lastFakeTick = now;
    tickFakeVisualizer();
  }
}

function renderRealLevels() {
  visualizerBars.forEach((bar, i) => {
    const [start, end] = bandRanges[i];
    let sum = 0;
    for (let b = start; b < end; b++) sum += freqData[b];
    setBarHeight(bar, sum / (end - start) / 255);
  });
}

// Simulated fallback: a dome-shaped curve across bands (more energy in the
// middle, tapering at the edges) plus a slow random-walk overall level, so it
// reads as a plausible EQ rather than random noise.
function tickFakeVisualizer() {
  fakeEnergy = clamp(fakeEnergy + (Math.random() - 0.5) * 0.3, 0.3, 1);
  const n = visualizerBars.length;
  visualizerBars.forEach((bar, i) => {
    const dome = Math.sin(((i + 0.5) / n) * Math.PI);
    const jitter = 0.55 + Math.random() * 0.45;
    setBarHeight(bar, clamp(dome * fakeEnergy * jitter, 0, 1));
  });
}

function setBarHeight(bar, level) {
  const px = Math.round(
    VISUALIZER.minHeightPx + clamp(level, 0, 1) * (VISUALIZER.maxHeightPx - VISUALIZER.minHeightPx)
  );
  bar.style.height = `${px}px`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function startNowPlaying(station) {
  stopNowPlaying();

  const config = station?.nowPlaying;
  const provider = config && NOW_PLAYING_PROVIDERS[config.type];
  if (!provider) return;

  const token = ++nowPlayingToken;
  const tick = async () => {
    let result = null;
    try {
      result = await provider(config);
    } catch {
      result = null;
    }
    if (token !== nowPlayingToken) return; // station changed while this fetch was in flight
    renderNowPlaying(result);
    nowPlayingPollTimeoutId = setTimeout(tick, NOW_PLAYING_POLL_MS);
  };
  tick();
}

function stopNowPlaying() {
  nowPlayingToken++;
  clearTimeout(nowPlayingPollTimeoutId);
  nowPlayingPollTimeoutId = null;
  renderNowPlaying(null);
}

function renderNowPlaying(result) {
  const raw = result?.raw?.trim();
  if (!els.nowPlaying) return;

  if (!raw) {
    els.nowPlaying.hidden = true;
    els.nowPlaying.innerHTML = "";
    return;
  }

  els.nowPlaying.hidden = false;
  els.nowPlaying.innerHTML = `
    <div class="display__now-playing-track">
      <span>${escapeHtml(raw)}</span>
      <span aria-hidden="true">${escapeHtml(raw)}</span>
    </div>
  `;

  updateNowPlayingTicker();
  if (!nowPlayingResizeBound) {
    nowPlayingResizeBound = true;
    window.addEventListener("resize", updateNowPlayingTicker);
  }
}

// Ticking only kicks in once the (single-copy) text actually overflows its
// container — short strings just sit still. Measured against the first
// span's width, since the track holds two copies side by side for the loop.
function updateNowPlayingTicker() {
  const track = els.nowPlaying?.querySelector(".display__now-playing-track");
  const firstCopy = track?.querySelector("span");
  if (!track || !firstCopy) return;
  // Force the span to its natural (unshrunk) width for this measurement,
  // regardless of which CSS state (ticking/not, reduced-motion) currently
  // has it flex-shrunk to fit — scrollWidth on a shrunk flex item isn't a
  // reliable read of the text's true intrinsic width.
  firstCopy.style.width = "max-content";
  const overflowing = firstCopy.scrollWidth > els.nowPlaying.clientWidth;
  firstCopy.style.width = "";
  track.classList.toggle("is-ticking", overflowing);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Splits a combined "Artist - Track" string. Returns nulls if it doesn't
// look like that shape (no separator, or one side is empty) rather than
// guessing wrong.
function splitArtistTrack(combined) {
  const parts = combined.split(" - ");
  if (parts.length !== 2) return { artist: null, track: null };
  const [artist, track] = parts.map((p) => p.trim());
  if (!artist || !track) return { artist: null, track: null };
  return { artist, track };
}

async function fetchNowPlayingJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("bad response");
  return res.json();
}

async function fetchSomaFmNowPlaying({ channel }) {
  const data = await fetchNowPlayingJson(`https://somafm.com/songs/${channel}.json`);
  const song = data?.songs?.[0];
  if (!song?.title) return null;
  return {
    raw: song.artist ? `${song.artist} - ${song.title}` : song.title,
    artist: song.artist ?? null,
    track: song.title,
  };
}

async function fetchRadioCoNowPlaying({ stationId }) {
  const data = await fetchNowPlayingJson(`https://public.radio.co/stations/${stationId}/status`);
  const raw = data?.current_track?.title;
  if (!raw) return null;
  return { raw, ...splitArtistTrack(raw) };
}

async function fetchIcecastNowPlaying({ statusUrl, listenUrlContains }) {
  const data = await fetchNowPlayingJson(statusUrl);
  const source = data?.icestats?.source;
  const mount = Array.isArray(source)
    ? source.find((s) => listenUrlContains && s.listenurl?.includes(listenUrlContains))
    : source;
  const raw = mount?.title;
  if (!raw) return null;
  return { raw, ...splitArtistTrack(raw) };
}

async function fetchAzuraCastNowPlaying({ apiUrl }) {
  const data = await fetchNowPlayingJson(apiUrl);
  const song = data?.now_playing?.song;
  if (!song?.title && !song?.text) return null;
  return { raw: song.text ?? song.title, artist: song.artist ?? null, track: song.title ?? null };
}

function togglePlay() {
  if (state.stations.length === 0) return;
  state.playing ? stop() : play();
}

function play() {
  if (state.stations.length === 0) return;
  state.playing = true;
  beginSeeking(state.currentIndex, 1);
}

// Starts (or restarts) a seek: like tuning a real radio dial, a dead station
// doesn't just error out — it keeps moving in `direction` until it finds one
// that's actually live, or gives up after a full lap back to `startIndex`
// (see advanceSeek()). Entry points (play/changeStation) call this to begin
// a fresh seek; handleStreamFailure() calls advanceSeek() to continue one
// already in progress, without resetting where "a full lap" started.
function beginSeeking(startIndex, direction) {
  seekStartIndex = startIndex;
  seekDirection = direction;
  tuneToStation(startIndex);
}

function tuneToStation(index) {
  const station = state.stations[index];
  if (!station) return;

  state.currentIndex = index;
  localStorage.setItem(STORAGE_KEYS.index, String(index));
  updateUrl();

  usingCors = true;
  // A new station gets a fresh shot at real analysis, even if the last one
  // fell back to the simulated animation.
  if (analyser) {
    visualizerMode = "probing";
    silentFrameCount = 0;
  }
  loadStream(station.streamUrl);
  setStatus("seeking");
}

function loadStream(url) {
  // Detach the previous load's listeners/timeout *before* starting this one,
  // so a stalled/aborted old connection can never fire a stale event against
  // whatever station happens to be current by the time it lands (the bug
  // behind "errors when I press next/prev while a station is still loading").
  currentLoadController?.abort();
  clearTimeout(connectTimeoutId);
  stopNowPlaying(); // clear any previous station's now-playing text immediately, don't wait for the new one

  const controller = new AbortController();
  currentLoadController = controller;
  const { signal } = controller;
  loadStartedAt = Date.now();

  // crossOrigin must be set before .src for it to take effect on this load.
  audio.crossOrigin = usingCors ? "anonymous" : null;
  audio.src = url;
  audio.load();

  audio.addEventListener("waiting", () => setStatus("seeking"), { signal });
  audio.addEventListener("playing", () => {
    clearTimeout(connectTimeoutId);
    setStatus("playing");
    startNowPlaying(state.stations[state.currentIndex]);
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
    // playback can still succeed. Without CORS the analyser is guaranteed to
    // read silence, so skip straight to the simulated fallback — no point
    // burning another probe window on a result we already know.
    usingCors = false;
    if (analyser) visualizerMode = "fake";
    loadStream(url);
    return;
  }
  // Genuinely dead (both CORS and no-CORS attempts failed) — this station is
  // off the air, so keep seeking rather than just erroring out.
  advanceSeek();
}

// Tries the next station in `seekDirection`. If that would be the very
// station this seek started from, we've made a full lap and nothing on the
// dial is live — land back there and give up rather than looping forever.
function advanceSeek() {
  const nextIndex = (state.currentIndex + seekDirection + state.stations.length) % state.stations.length;
  if (nextIndex === seekStartIndex) {
    giveUpSeeking(nextIndex);
    return;
  }
  tuneToStation(nextIndex);
}

function giveUpSeeking(index) {
  currentLoadController?.abort();
  currentLoadController = null;
  clearTimeout(connectTimeoutId);
  stopNowPlaying();
  state.currentIndex = index;
  localStorage.setItem(STORAGE_KEYS.index, String(index));
  updateUrl();
  state.playing = false;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  setStatus("error");
}

function stop() {
  currentLoadController?.abort();
  currentLoadController = null;
  clearTimeout(connectTimeoutId);
  stopNowPlaying();
  state.playing = false;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  setStatus("idle");
}

function changeStation(delta) {
  if (state.stations.length === 0) return;
  const nextIndex = (state.currentIndex + delta + state.stations.length) % state.stations.length;
  state.playing = true;
  beginSeeking(nextIndex, delta >= 0 ? 1 : -1);
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
