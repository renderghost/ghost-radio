// Caches the static shell only — never the audio streams or now-playing API
// calls, which are cross-origin and explicitly skipped below. Strategy is
// stale-while-revalidate: serve from cache instantly if present, refresh the
// cache from network in the background, and fall back to cache if offline.
//
// Bump CACHE_NAME whenever a shell file changes. This repo has no build
// step and is meant to be hand-edited (see README) — stations.json in
// particular changes independently of any of this — so a stale cache with
// no way to invalidate would be a real footgun. Bumping the version is what
// clears out the old cache on the next visit (see the "activate" handler).
const CACHE_NAME = "ghost-radio-shell-v1";

const SHELL_FILES = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/stations.json",
  "/manifest.json",
  "/art/favicon-16.png",
  "/art/favicon-32.png",
  "/art/favicon-64.png",
  "/art/favicon-256.png",
  "/art/logo-light.png",
  "/art/logo-dark.png",
  "/art/dots.svg",
  "/art/mode-light.svg",
  "/art/mode-dark.svg",
  "/art/mode-device.svg",
  "/art/transport-back.svg",
  "/art/transport-play.svg",
  "/art/transport-forward.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // stream URLs, now-playing APIs — never intercepted
  if (!SHELL_FILES.includes(url.pathname)) return; // only the known shell files

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
