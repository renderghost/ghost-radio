const STORAGE_KEYS = {
  theme: "ghost-radio:theme",
  index: "ghost-radio:index",
};

const MAX_STATIONS = 10;

const state = {
  stations: [],
  currentIndex: 0,
  playing: false,
  status: "idle", // idle | connecting | playing | error
  theme: "system", // light | dark | system
};

const audio = document.getElementById("audio");

const els = {
  stationName: document.getElementById("station-name"),
  displayMeta: document.getElementById("display-meta"),
  btnPlay: document.getElementById("btn-play"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  iconPlay: document.getElementById("icon-play"),
  iconStop: document.getElementById("icon-stop"),
  dials: document.getElementById("dials"),
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

  buildDials();
  bindEvents();
  render();
}

async function loadStations() {
  try {
    const res = await fetch("stations.json");
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("not an array");
    return data
      .filter((s) => s && typeof s.title === "string" && typeof s.streamUrl === "string")
      .slice(0, MAX_STATIONS);
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

function selectStation(index) {
  if (!state.stations[index]) return;
  state.currentIndex = index;
  localStorage.setItem(STORAGE_KEYS.index, String(state.currentIndex));
  play();
}

function setStatus(status) {
  state.status = status;
  render();
}

function buildDials() {
  els.dials.innerHTML = "";
  for (let i = 0; i < MAX_STATIONS; i++) {
    const station = state.stations[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--dial";
    btn.textContent = String(i + 1);
    btn.disabled = !station;
    btn.setAttribute("aria-label", station ? `Play ${station.title}` : `Preset ${i + 1} (empty)`);
    btn.addEventListener("click", () => selectStation(i));
    els.dials.appendChild(btn);
  }
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

  els.displayMeta.textContent = state.status === "error" ? "SIGNAL LOST" : "";

  document.body.dataset.status = state.status;

  els.btnPlay.classList.toggle("is-playing", state.playing);
  els.btnPlay.setAttribute("aria-label", state.playing ? "Stop" : "Play");
  els.iconPlay.hidden = state.playing;
  els.iconStop.hidden = !state.playing;

  [els.btnPlay, els.btnPrev, els.btnNext].forEach((btn) => {
    btn.disabled = !hasStations;
  });

  renderDials();
}

function renderDials() {
  [...els.dials.children].forEach((btn, i) => {
    btn.classList.toggle("is-active", i === state.currentIndex && !!state.stations[i]);
  });
}

function renderThemeButtons() {
  els.themeButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.themeChoice === state.theme);
  });
}
