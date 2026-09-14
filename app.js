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
  themeButtons: document.querySelectorAll("[data-theme-choice]"),
};

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

  audio.addEventListener("waiting", () => setStatus("connecting"));
  audio.addEventListener("playing", () => setStatus("playing"));
  audio.addEventListener("error", () => {
    state.playing = false;
    setStatus("error");
  });
  audio.addEventListener("stalled", () => setStatus("error"));
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

function togglePlay() {
  if (state.stations.length === 0) return;
  state.playing ? stop() : play();
}

function play() {
  const station = state.stations[state.currentIndex];
  if (!station) return;
  state.playing = true;
  audio.src = station.streamUrl;
  audio.play().catch(() => {
    state.playing = false;
    setStatus("error");
  });
  setStatus("connecting");
}

function stop() {
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
