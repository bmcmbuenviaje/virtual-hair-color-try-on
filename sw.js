/* iColor Plus — service worker (offline kiosk cache) */
const CACHE = "icolor-v1";
const SHELL = [
  "./", "index.html", "app.js", "analytics.js", "config.default.js",
  "styles.css", "manifest.webmanifest", "assets/logo.svg",
];
// Cross-origin runtime caches (MediaPipe wasm/model, QR lib).
const RUNTIME_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const runtimeCdn = RUNTIME_HOSTS.includes(url.hostname);
  if (!sameOrigin && !runtimeCdn) return; // don't touch other requests

  // Cache-first for the app shell + big CDN deps (model/wasm/qr rarely change).
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit); // offline & uncached → fail gracefully
    })
  );
});
