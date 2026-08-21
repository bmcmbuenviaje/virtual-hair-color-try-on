/* iColor Plus — service worker (offline kiosk cache) */
const CACHE = "icolor-v4";
const SHELL = [
  "./", "index.html", "app.js", "analytics.js", "backend.js", "config.default.js",
  "config.local.js", "commerce.js", "styles.css", "manifest.webmanifest", "assets/logo.svg",
  // vendored libs so the backend + QR work fully offline (no CDN dependency)
  "assets/vendor/pocketbase.umd.js", "assets/vendor/qrcode.js",
];
// Cross-origin runtime caches (MediaPipe wasm/model still load from a CDN).
const RUNTIME_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com"];

self.addEventListener("install", (e) => {
  // Precache fresh copies (bypass the HTTP cache) as the offline fallback.
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(SHELL.map((u) =>
        fetch(u, { cache: "no-store" }).then((r) => (r && r.ok ? c.put(u, r.clone()) : null)).catch(() => {})
      ))
    ).then(() => self.skipWaiting())
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
  // Never cache backend API / admin traffic — always hit the network.
  if (sameOrigin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_/") || url.pathname === "/scanping")) return;

  // Big cross-origin CDN deps (MediaPipe model/wasm) rarely change → cache-first.
  if (runtimeCdn) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
          return res;
        }).catch(() => hit)
      )
    );
    return;
  }

  // The app's own files → NETWORK-FIRST with cache:no-store so a new deploy is seen
  // immediately (bypasses GitHub Pages' HTTP max-age). Falls back to cache offline.
  e.respondWith(
    fetch(req, { cache: "no-store" }).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() =>
      caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined))
    )
  );
});
