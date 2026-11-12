const { AsyncLocalStorage } = require("async_hooks");

// Per-request context for the audit trail (foundation). The audit logger runs
// fire-and-forget INSIDE services that never see `req`, so the client IP is
// carried here via AsyncLocalStorage instead of threading a new parameter
// through every controller/view call site. Purely additive: the store only
// observes `req.ip` (already proxy-aware via the app's trust-proxy setting)
// and never alters the request, the response or any existing middleware.
const storage = new AsyncLocalStorage();

function requestContext(req, res, next) {
  // Reading req.ip can throw only on a malformed proxy setup; a context
  // hiccup must never break the request itself — fall back to an empty store.
  let ip = "";
  try {
    ip = req.ip || "";
  } catch {
    ip = "";
  }
  storage.run({ ip }, next);
}

// Returns the current request's store, or undefined outside a request
// (scripts, timers, unit tests) — callers treat a missing IP as optional.
function getRequestContext() {
  return storage.getStore();
}

module.exports = { requestContext, getRequestContext };