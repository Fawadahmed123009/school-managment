// ── PWA registration (production only) ───────────────────────────
// Registers /sw.js ONLY on a secure HTTPS origin that is not a local dev
// host. Local development (http://localhost:3001, 127.0.0.1, LAN IPs,
// *.localhost) never registers the service worker — no caching, no
// offline behaviour, exactly the pre-PWA request flow.
(function () {
  "use strict";

  function isLocalDevHost(hostname) {
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      /^127\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^10\./.test(hostname)
    );
  }

  var productionLike =
    window.isSecureContext &&
    location.protocol === "https:" &&
    !isLocalDevHost(location.hostname);

  if (!productionLike) return;
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function () {
      // Registration failure must never break the portal — fail silently.
    });
  });

  // ── Logout: purge all SW caches before leaving the authenticated area ──
  // HTML is never cached by the SW, but this is defense-in-depth: any
  // cached response (and anything a previous SW version stored) is removed
  // so a later back-button replay on a shared device can't surface the
  // previous user's content. Works even if this page predates the SW.
  function purgeCaches() {
    var viaWorker = Promise.resolve();
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      try {
        navigator.serviceWorker.controller.postMessage({ type: "PURGE_CACHES" });
      } catch (e) {
        /* ignore */
      }
    }
    var viaPage = Promise.resolve();
    if (typeof caches !== "undefined" && caches.keys) {
      viaPage = caches
        .keys()
        .then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        })
        .catch(function () {
          /* ignore */
        });
    }
    return Promise.all([viaWorker, viaPage]);
  }

  document.addEventListener("click", function (e) {
    var link = e.target && e.target.closest ? e.target.closest('a[href="/logout"]') : null;
    if (!link) return;
    e.preventDefault();
    purgeCaches().then(function () {
      location.href = "/logout";
    });
  });
})();
