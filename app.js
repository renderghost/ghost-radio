const STORAGE_KEYS = {
  theme: "ghost-radio:theme",
  index: "ghost-radio:index",
};

const state = {
  stations: [],
  currentIndex: 0,
  playing: false,
  everPlayed: false, // has the user ever started playback this session? — see updateMediaSessionState()
  status: "idle", // idle | seeking | playing | error
  theme: "system", // light | dark | system
  pickerOpen: false,
};

const audio = document.getElementById("audio");
// Never passed to createMediaElementSource() — per spec, once an element is
// routed into a Web Audio graph its output can never go back to playing
// natively, for the lifetime of the page. Stations flagged `noCors` use this
// element instead, so their audio is guaranteed to play exactly like opening
// the stream URL directly in a browser tab, with zero Web Audio involvement
// (and consequently no real visualizer analysis — they always show the
// fake/seeking animation, which is an honest trade-off for actually working).
const audioPlain = document.getElementById("audio-plain");

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
  fakeUpdateIntervalMs: 140, // how often the simulated "playing but can't analyze" fallback picks new target bar levels
  seekingWaveCycles: 2.5, // how many full sine cycles are visible across the bars at once
  seekingWaveSpeed: 1.6, // radians/sec the seeking wave phases left-to-right at
  seekingWaveBaseline: 0.42, // center height of the seeking wave (0-1)
  seekingWaveAmplitude: 0.38, // how far above/below baseline the seeking wave swings (0-1)
};

const VIZ_MIN_SCALE = VISUALIZER.minHeightPx / VISUALIZER.maxHeightPx; // keep in sync with --viz-min-scale in styles.css

const STATUS_LABELS = {
  idle: "Off Air",
  seeking: "Seeking",
  playing: "Live",
  error: "Signal Lost",
};

const BASE_TITLE = document.title; // whatever's in index.html's <title> — read once so the two can't drift

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
  wnyc: fetchWnycNowPlaying,
  nts: fetchNtsNowPlaying,
  airtime: fetchAirtimeNowPlaying,
  alhara: fetchAlharaNowPlaying,
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
  metaThemeColor: document.getElementById("meta-theme-color"),
  display: document.getElementById("display"),
  stationPicker: document.getElementById("station-picker"),
  faviconLinks: [
    document.getElementById("favicon-16"),
    document.getElementById("favicon-32"),
    document.getElementById("favicon-64"),
  ].filter(Boolean),
};

// The tab favicon swaps to an accent-colored "-active" variant while a
// station is actually live — mirrors the accent-colored .display__status dot
// in the UI itself. Only the sizes browsers actually use as a tab icon get a
// variant (see the favicon-16/32/64 ids above); the 256px one is
// install-time-fixed (apple-touch-icon/manifest) and can't change at
// runtime, so it's excluded. Default hrefs are captured up front so the
// "-active" swap can be derived rather than duplicating each path.
const FAVICON_DEFAULT_HREFS = new Map(els.faviconLinks.map((link) => [link, link.getAttribute("href")]));

const THEME_COLORS = {
  light: "hsl(16, 10%, 84%)", // keep in sync with --bg under :root in styles.css
  dark: "hsl(16, 10%, 6%)", // keep in sync with --bg under html[data-theme="dark"] in styles.css
};

const COPIED_LABEL_MS = 1000; // how long the Copy button shows "Copied" before reverting

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
let visualizerMode = "idle"; // "idle" | "seeking" | "probing" | "real" | "fake"
let audioConfirmedPlaying = false; // has the "playing" event fired for the current attempt yet? — while false, "fake" mode shows the seeking wave instead of the dome-random fallback
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
let stationAttemptStartedAt = 0; // when this station's attempt began (both the CORS try and its no-CORS retry share this budget — see CONNECT_TIMEOUT_MS)
let nowPlayingPollTimeoutId = null;
let nowPlayingToken = 0; // bumped on every startNowPlaying()/stopNowPlaying() so a late fetch from an abandoned station can't render itself
let nowPlayingResizeBound = false;
let seekStartIndex = 0; // the first station tried this seek — wrapping back to it means every station is dead
let seekDirection = 1; // 1 = forward (next), -1 = backward (previous)
let activeAudio = audio; // whichever element (audio or audioPlain) the current station is loaded into

init();
registerServiceWorker();

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
  buildStationPicker();
  bindEvents();
  bindMediaSession();
  bindKeyboardShortcuts();
  render();
}

// Feature-detected, registered after load so it doesn't compete with the
// initial page load for resources. See sw.js for the caching strategy.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
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

  els.stationName.addEventListener("click", togglePicker);

  // Single delegated listener rather than one per row.
  els.stationPicker.addEventListener("click", (e) => {
    const item = e.target.closest(".station-picker__item");
    if (item) selectStation(Number(item.dataset.index));
  });

  // Closes on any click outside the list — the station-name button (the
  // trigger) is excluded so its own click handler above can toggle without
  // this immediately closing what it just opened.
  document.addEventListener("click", (e) => {
    if (!state.pickerOpen) return;
    if (e.target.closest("#station-picker") || e.target.closest("#station-name")) return;
    closePicker();
  });

  // Only the visualizer's rAF loop pauses while the tab is hidden — audio
  // playback is untouched. See startVisualizer()'s document.hidden guard.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (state.playing) startVisualizer();
    resyncMediaSession();
  });

  // Covers the bfcache-restore case (e.g. Safari's back/forward swipe, or
  // returning to a backgrounded tab that got fully suspended) — visibility
  // can go straight from hidden to visible without a visibilitychange event
  // firing on the way back in.
  window.addEventListener("pageshow", resyncMediaSession);

  els.themeButtons.forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice));
  });
}

// iOS is known to drop or ignore the media session while a page is
// backgrounded (WebKit bug 261858), sometimes leaving the lock screen/
// Control Center widget unresponsive until the page is reactivated —
// re-asserting the handlers and current state here is a best-effort recovery
// for whenever that happens.
function resyncMediaSession() {
  bindMediaSession();
  updateMediaSessionState(state.stations[state.currentIndex]);
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

// Deliberately never registers seekbackward/seekforward: this is a 3-button
// radio player (play/pause, previous station, next station) playing
// indefinite live streams, not seekable tracks. iOS shows either the
// previous/next pair or the ±10s seek pair on its lock screen/Control Center
// widget — never both — so adding seek handlers would silently replace
// station-skip with skip-by-10-seconds there.
//
// Idempotent and safe to call repeatedly — see the visibilitychange/pageshow
// listeners in bindEvents(), which re-call this to recover from iOS
// suspending/dropping the media session while the page is backgrounded
// (WebKit bug 261858: https://bugs.webkit.org/show_bug.cgi?id=261858).
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

    // While the picker is open, only Escape is handled here — Tab/Enter/
    // Space navigating and activating the list buttons is native browser
    // behavior, and the transport shortcuts below would otherwise fight it
    // (e.g. Space would both activate a focused row AND toggle playback).
    if (state.pickerOpen) {
      if (e.code === "Escape") {
        e.preventDefault();
        closePicker();
      }
      return;
    }

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

// Built once from state.stations; only ever toggled visible/hidden after
// this, not rebuilt — see the .display.is-picker-open rules in styles.css.
function buildStationPicker() {
  els.stationPicker.innerHTML = "";
  const fragment = document.createDocumentFragment();
  state.stations.forEach((station, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "station-picker__item";
    item.role = "option";
    item.dataset.index = String(index);

    const name = document.createElement("span");
    name.className = "station-picker__name";
    name.textContent = station.title;
    item.appendChild(name);

    if (station.location) {
      const location = document.createElement("span");
      location.className = "station-picker__location";
      location.textContent = station.location;
      item.appendChild(location);
    }

    fragment.appendChild(item);
  });
  els.stationPicker.appendChild(fragment);
}

function togglePicker() {
  state.pickerOpen ? closePicker() : openPicker();
}

function openPicker() {
  if (state.stations.length === 0) return;
  state.pickerOpen = true;
  render();

  // Land keyboard focus near the current station rather than at the top —
  // falls back to the first row if the current station isn't in the list.
  const current = els.stationPicker.querySelector(`[data-index="${state.currentIndex}"]`);
  (current || els.stationPicker.firstElementChild)?.focus();
}

function closePicker() {
  state.pickerOpen = false;
  render();
  els.stationName.focus();
}

function selectStation(index) {
  state.pickerOpen = false;
  state.playing = true;
  beginSeeking(index, 1);
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
  // Don't spend a rAF loop drawing bars nobody can see — the visibilitychange
  // listener in bindEvents() calls this again once the tab is visible.
  if (document.hidden) return;
  if (visualizerFrame) return;
  runVisualizerFrame();
}

function stopVisualizer() {
  if (visualizerFrame) {
    cancelAnimationFrame(visualizerFrame);
    visualizerFrame = null;
  }
  visualizerMode = "idle";
  visualizerBars.forEach((bar) => setBarLevel(bar, 0));
}

function runVisualizerFrame(timestamp) {
  visualizerFrame = requestAnimationFrame(runVisualizerFrame);
  const now = timestamp ?? performance.now();

  if (!audioConfirmedPlaying) {
    // Nothing has actually started decoding yet, so real analysis is
    // guaranteed to read silence — skip straight to the seeking wave rather
    // than sitting idle through a probing window that can't possibly pay off.
    visualizerMode = "seeking";
    tickSeekingVisualizer(now);
    return;
  }

  if (visualizerMode === "seeking" || visualizerMode === "idle") {
    // Just switched over to confirmed-playing — give real analysis a fresh
    // probing window (the CSS transition on each bar smooths the handover
    // from the seeking wave's last frame into whatever comes next).
    visualizerMode = analyser ? "probing" : "fake";
    silentFrameCount = 0;
  }

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
  if (now - lastFakeTick >= VISUALIZER.fakeUpdateIntervalMs) {
    lastFakeTick = now;
    tickFakeVisualizer();
  }
}

// Simulated "no signal yet" animation while a station is still being sought:
// a sine wave that phases smoothly from left to right. Distinct from
// tickFakeVisualizer()'s settled dome-random look, which only kicks in once
// audio is confirmed playing but can't be analyzed.
function tickSeekingVisualizer(timestampMs) {
  const t = timestampMs / 1000;
  const n = visualizerBars.length;
  visualizerBars.forEach((bar, i) => {
    const phase = (i / n) * VISUALIZER.seekingWaveCycles * 2 * Math.PI - t * VISUALIZER.seekingWaveSpeed;
    const level = VISUALIZER.seekingWaveBaseline + VISUALIZER.seekingWaveAmplitude * Math.sin(phase);
    setBarLevel(bar, level);
  });
}

function renderRealLevels() {
  visualizerBars.forEach((bar, i) => {
    const [start, end] = bandRanges[i];
    let sum = 0;
    for (let b = start; b < end; b++) sum += freqData[b];
    setBarLevel(bar, sum / (end - start) / 255);
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
    setBarLevel(bar, clamp(dome * fakeEnergy * jitter, 0, 1));
  });
}

// Writes transform: scaleY() rather than height — a layout property — so the
// browser can animate this on the compositor thread instead of reflowing the
// page every frame for as long as a station plays.
function setBarLevel(bar, level) {
  const scale = VIZ_MIN_SCALE + clamp(level, 0, 1) * (1 - VIZ_MIN_SCALE);
  bar.style.transform = `scaleY(${scale})`;
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
  const raw = result?.raw ? cleanNowPlayingText(result.raw) : "";
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

// Now-playing feeds are a mixed bag: some upstream sources mis-decode UTF-8
// as Latin-1 before it ever reaches their API (so we receive already-corrupted
// text like "BeyoncÃ©" for "Beyoncé"), some leak literal backslash-escaped
// quotes or HTML entities from whatever templating produced the metadata
// (e.g. Icecast source clients that pass "title='...'" and never strip the
// quotes, or "&amp;" left undecoded), and others sprinkle in stray control or
// zero-width characters. None of that survives a straight display, so clean
// it all up before the text is shown.
function cleanNowPlayingText(str) {
  let cleaned = repairMojibake(str)
    .replace(/\\(['"])/g, "$1")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�​-‏﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripWrappingQuotes(cleaned);
  return cleaned;
}

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeHtmlEntities(str) {
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1].toLowerCase() === "x";
      const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// Some sources (Icecast title fields especially) include the whole string
// wrapped in a single matching pair of quotes as a literal artifact of how
// the source client formatted the metadata, e.g. "'Artist - Track (1995)'".
function stripWrappingQuotes(str) {
  if (str.length < 2) return str;
  const first = str[0];
  if ((first === "'" || first === '"') && str[str.length - 1] === first) {
    return str.slice(1, -1).trim();
  }
  return str;
}

// Detects the classic "UTF-8 bytes read as Latin-1" mojibake pattern (runs of
// Ã/Â/â-prefixed characters) and reverses it by reinterpreting the string's
// char codes as raw bytes and re-decoding them as UTF-8. Only attempted when
// every character is in the Latin-1 range, since that's a precondition for
// this kind of corruption — mixed content means it isn't this bug.
function repairMojibake(str) {
  if (!/[ÂÃâ][\u0080-¿]/.test(str)) return str;
  if (!/^[\u0000-ÿ]*$/.test(str)) return str;
  try {
    const bytes = Uint8Array.from(str, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return str;
  }
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

// api.wnyc.org only sends Access-Control-Allow-Origin for *.wqxr.org (and
// sibling NYPR) origins, not for this site — so this fetch is CORS-blocked in
// production and always resolves to nothing. Kept correct against the real
// API shape (composer as artist, piece title as track) for whenever that
// changes, e.g. behind a proxy.
async function fetchWnycNowPlaying({ slug }) {
  const data = await fetchNowPlayingJson(`https://api.wnyc.org/api/v1/whats_on/${slug}/`);
  const entry = data?.current_playlist_item?.catalog_entry;
  const track = entry?.title;
  if (!track) return null;
  const artist = entry?.composer?.name ?? null;
  return { raw: artist ? `${artist} - ${track}` : track, artist, track };
}

// NTS's own now-playing list covers both its channels in one response; pick
// out the one matching this station's channel number. Gives a show title
// (e.g. "Secretsundaze"), not a track, so no artist/track split applies.
async function fetchNtsNowPlaying({ channel }) {
  const data = await fetchNowPlayingJson("https://www.nts.live/api/v2/live");
  const entry = data?.results?.find((r) => r.channel_name === String(channel));
  const raw = entry?.now?.broadcast_title;
  if (!raw) return null;
  return { raw, artist: null, track: null };
}

// Airtime (airtime.pro-hosted stations): the now-playing API lives on the
// base <slug>.airtime.pro host, not the out.airtime.pro subdomain used for
// the audio stream itself. Prefers the actual playing track; live DJ sets
// have no track-level data, so falls back to the current show's name.
async function fetchAirtimeNowPlaying({ slug }) {
  const data = await fetchNowPlayingJson(`https://${slug}.airtime.pro/api/live-info-v2`);
  const track = data?.tracks?.current;
  if (track?.type === "track" && track.name) {
    const artist = track.metadata?.artist_name || null;
    const title = track.metadata?.track_title || track.name;
    return { raw: artist ? `${artist} - ${title}` : title, artist, track: title };
  }
  const show = data?.shows?.current?.name;
  if (!show) return null;
  return { raw: show, artist: null, track: null };
}

async function fetchAlharaNowPlaying() {
  const data = await fetchNowPlayingJson("https://ch2.radioalhara.net/api/now-playing");
  const title = data?.title;
  if (!title) return null;
  const artist = data?.artist ?? null;
  return { raw: artist ? `${artist} - ${title}` : title, artist, track: title };
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
  state.everPlayed = true;
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

  // Most stations get a real shot at CORS (for actual spectrum analysis),
  // falling back to a plain load if that fails (see handleStreamFailure()).
  // A few have servers that are guaranteed to fail CORS in a way the retry
  // can't cleanly recover from (e.g. Vintage Obscura sends a malformed,
  // duplicated Access-Control-Allow-Origin header, which Chrome rejects
  // outright) — those opt out via `noCors`, skip the CORS attempt, AND use
  // audioPlain instead of audio, so they're never touched by Web Audio at
  // all (see audioPlain's declaration for why that matters).
  const nextAudio = station.noCors ? audioPlain : audio;
  if (nextAudio !== activeAudio) resetAudioElement(activeAudio); // stop whatever the other element was doing
  activeAudio = nextAudio;

  usingCors = !station.noCors;
  stationAttemptStartedAt = Date.now();
  loadStream(station.streamUrl);
  setStatus("seeking");
}

function resetAudioElement(el) {
  el.pause();
  el.removeAttribute("src");
  el.load();
}

function loadStream(url) {
  // Detach the previous load's listeners/timeout *before* starting this one,
  // so a stalled/aborted old connection can never fire a stale event against
  // whatever station happens to be current by the time it lands (the bug
  // behind "errors when I press next/prev while a station is still loading").
  currentLoadController?.abort();
  clearTimeout(connectTimeoutId);
  stopNowPlaying(); // clear any previous station's now-playing text immediately, don't wait for the new one
  audioConfirmedPlaying = false;

  const controller = new AbortController();
  currentLoadController = controller;
  const { signal } = controller;
  loadStartedAt = Date.now();

  // crossOrigin must be set before .src for it to take effect on this load.
  activeAudio.crossOrigin = usingCors ? "anonymous" : null;
  activeAudio.src = url;
  activeAudio.load();

  activeAudio.addEventListener("waiting", () => setStatus("seeking"), { signal });
  activeAudio.addEventListener("playing", () => {
    clearTimeout(connectTimeoutId);
    audioConfirmedPlaying = true;
    setStatus("playing");
    startNowPlaying(state.stations[state.currentIndex]);
  }, { signal });
  activeAudio.addEventListener("error", () => handleStreamFailure(url), { signal });
  activeAudio.addEventListener("stalled", () => handleStreamFailure(url), { signal });

  // The no-CORS retry (see handleStreamFailure()) shares this station's
  // overall budget rather than getting a fresh CONNECT_TIMEOUT_MS of its own
  // — otherwise a dead station would take up to 2x as long to give up on.
  // Skips the stale-echo check below: clearTimeout() above already guarantees
  // an old load's timeout can never fire after a new one starts, so unlike
  // the error/stalled events (which use a separate, less immediate cleanup
  // path), this can't ever be a late echo — and with a near-zero remaining
  // budget on the retry, it could otherwise fire within the grace window and
  // get wrongly discarded as one, silently freezing the seek entirely.
  const remainingBudget = Math.max(0, CONNECT_TIMEOUT_MS - (Date.now() - stationAttemptStartedAt));
  connectTimeoutId = setTimeout(() => handleStreamFailure(url, { skipStaleCheck: true }), remainingBudget);

  activeAudio.play().catch(() => {
    // Real failures are surfaced via the "error"/"stalled" listeners above.
  });
}

function handleStreamFailure(url, { skipStaleCheck = false } = {}) {
  if (!skipStaleCheck && Date.now() - loadStartedAt < STALE_EVENT_GRACE_MS) return; // likely a stale echo — see STALE_EVENT_GRACE_MS above
  clearTimeout(connectTimeoutId);
  if (usingCors) {
    // Most streams don't send CORS headers. Retry once without it so
    // playback can still succeed — the visualizer stays on the seeking wave
    // either way until audio is actually confirmed playing.
    usingCors = false;
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
  resetAudioElement(activeAudio);
  setStatus("error");
}

function stop() {
  currentLoadController?.abort();
  currentLoadController = null;
  clearTimeout(connectTimeoutId);
  stopNowPlaying();
  state.playing = false;
  resetAudioElement(activeAudio);
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
  if (els.metaThemeColor) els.metaThemeColor.content = THEME_COLORS[effective];
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

  [els.btnPlay, els.btnPrev, els.btnNext, els.stationName].forEach((btn) => {
    btn.disabled = !hasStations;
  });

  els.display.classList.toggle("is-picker-open", state.pickerOpen);
  els.stationName.setAttribute("aria-expanded", String(state.pickerOpen));
  els.stationPicker.querySelectorAll(".station-picker__item").forEach((item) => {
    item.setAttribute("aria-selected", String(Number(item.dataset.index) === state.currentIndex));
  });

  state.playing ? startVisualizer() : stopVisualizer();

  updateMediaSessionState(station);
  updateDocumentTitle(station);
  updateFavicon();
}

function updateFavicon() {
  const active = state.status === "playing";
  els.faviconLinks.forEach((link) => {
    const defaultHref = FAVICON_DEFAULT_HREFS.get(link);
    link.href = active ? defaultHref.replace("favicon-", "favicon-active-") : defaultHref;
  });
}

// Lets the tab be told apart from others (and checked at a glance without
// switching to it) while backgrounded — reuses STATUS_LABELS so the title
// stays consistent with what's already shown in the UI.
function updateDocumentTitle(station) {
  if (state.status === "playing" && station) {
    document.title = `${station.title} — ${BASE_TITLE}`;
  } else if (state.status === "seeking" || state.status === "error") {
    document.title = `${STATUS_LABELS[state.status]} — ${BASE_TITLE}`;
  } else {
    document.title = BASE_TITLE;
  }
}

function updateMediaSessionState(station) {
  if (!("mediaSession" in navigator)) return;

  // Nothing has ever been played this session — leave the OS with no Now
  // Playing session at all, rather than a phantom "paused: <first station>"
  // one nobody asked for.
  if (!state.everPlayed || !station) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
    try {
      navigator.mediaSession.setPositionState();
    } catch {
      // Not supported — nothing to clear.
    }
    return;
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: station.title,
    artist: station.location ?? "",
    album: "Ghost Radio",
    artwork: [{ src: "art/favicon-256.png", sizes: "256x256", type: "image/png" }],
  });

  navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";

  // Every station here is an indefinite live stream, so duration is
  // Infinity (spec-legal, and the documented way to signal "no scrubber" —
  // see https://developer.mozilla.org/en-US/docs/Web/API/MediaSession/setPositionState).
  // playbackRate can't be 0 per spec even while paused; `playbackState`
  // above is what tells the OS playback isn't actually advancing.
  try {
    navigator.mediaSession.setPositionState({ duration: Infinity, position: 0, playbackRate: 1 });
  } catch {
    // Not supported by this browser — the widget just won't show a scrubber.
  }
}

function renderThemeButtons() {
  els.themeButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.themeChoice === state.theme);
  });
}
