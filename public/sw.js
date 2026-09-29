// ── Avenir Academy PWA service worker ────────────────────────────
// Caching policy (strict):
//   • Cache-first: static assets ONLY — /css/*, /js/*, /images/*,
//     /manifest.json, /offline.html.
//   • NEVER cached: every HTML page (all navigations), every /api/* route,
//     every non-GET request (POST/PUT/DELETE), /uploads/* (auth-gated),
//     and anything under authenticated portal paths. These always hit the
//     network so a stale page can never be served to the wrong logged-in
//     role, and CSRF tokens / session-dependent responses are never stored.
//   • Offline fallback: /offline.html is served for NAVIGATION requests
//     only, and only when the network itself failed (TypeError) — never
//     for failed API calls or failed responses (4xx/5xx pass through).
//
// Bump CACHE_VERSION when static assets change in a way that must invalidate.
// v2: regenerated /images/icons/* (padded) — drop the stale edge-to-edge copies.
const CACHE_VERSION = "v2";
const STATIC_CACHE = `avenir-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

// Paths eligible for cache-first. Everything else is network-only.
const STATIC_PATTERNS = [
  /^\/css\//,
  /^\/js\//,
  /^\/images\//,
  /^\/manifest\.json$/,
  /^\/offline\.html$/,
];

function isStaticAsset(pathname) {
  return STATIC_PATTERNS.some((re) => re.test(pathname));
}

self.addEventListener("install", (event) => {
  // Pre-cache the offline shell so it is available on the very first
  // dropped connection. Do NOT skipWaiting() blindly: wait until the new
  // worker controls the next navigation to avoid half-updated assets.
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, "/manifest.json"]))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))
      );
      await clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // POST / PUT / DELETE / anything mutating: pass through untouched.
  // The browser goes straight to the network; we never cache or replay.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin (Google Fonts, jsDelivr Chart.js, R2 CDN): default
  // browser behaviour (HTTP cache only). We store nothing ourselves.
  if (url.origin !== self.location.origin) return;

  // Authenticated / dynamic paths that must NEVER be cached:
  //   /api/*            — JSON endpoints (incl. CSRF token, session data)
  //   /uploads/*        — auth-gated files
  //   everything else   — HTML portals, dashboards, mark-entry, fee
  //                       collection, reports, OCR, parent-portal…
  // Only whitelisted static assets fall through to cache-first below.
  if (!isStaticAsset(url.pathname)) {
    if (req.mode === "navigate") {
      // Page request: network only. Offline fallback ONLY when the fetch
      // itself fails (no network), never on 401/403/500 responses.
      event.respondWith(
        fetch(req).catch(() =>
          caches.match(OFFLINE_URL).then((cached) => cached || Response.error())
        )
      );
    }
    // Non-navigation dynamic requests: leave to the browser (pure network).
    return;
  }

  // Static asset: cache-first with background fill on miss.
  event.respondWith(
    (async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === "basic") {
        const cache = await caches.open(STATIC_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    })()
  );
});

// Logout hardening: the page posts this before navigating to /logout so
// no previously cached asset lingers for the next (possibly different)
// user of the same browser. Static assets re-populate on next visit.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "PURGE_CACHES") {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      })()
    );
  }
});
