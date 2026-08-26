const crypto = require("crypto");

// ── CSRF protection for the session-cookie portal ─────────────────────────────
// The API (/api/v1/*) is stateless-Bearer authenticated and not cookie-driven,
// so it isn't CSRF-exposed. The server-rendered portal, however, authenticates
// with a `session` cookie (see middlewares/authView.js), which the browser
// attaches automatically — the classic CSRF setup.
//
// The token is a synchronizer token bound to the session JWT itself:
//   csrfToken = base64url( HMAC-SHA256(JWT_SECRET_KEY, sessionToken) )
// This is stateless (no server-side store), rotates whenever the session token
// does (login / 1-day expiry), and can't be forged: an attacker knows neither
// JWT_SECRET_KEY nor the victim's session token (the cookie is httpOnly +
// same-origin, so it can't be read cross-site). It layers on top of the
// cookie's SameSite=Lax attribute, which already withholds the cookie from
// cross-site POSTs.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const generateCsrfToken = (sessionToken) => {
  if (!sessionToken) return "";
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET_KEY)
    .update(String(sessionToken))
    .digest("base64url");
};

// Constant-time string compare that never throws on length mismatch.
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

// Exposes the current session's CSRF token to templates as `csrfToken`
// (res.locals). Mount after authView so req.token is populated.
const attachCsrfToken = (req, res, next) => {
  res.locals.csrfToken = generateCsrfToken(req.token);
  next();
};

const rejectCsrf = (req, res) => {
  const wantsJson =
    req.xhr ||
    (req.get("accept") || "").includes("application/json") ||
    (req.get("content-type") || "").includes("application/json");

  if (wantsJson) {
    return res.status(403).json({ status: "failed", message: "Invalid or missing CSRF token" });
  }
  return res.status(403).render("error", {
    title: "Request blocked",
    message: "Your security token was missing or invalid. Please reload the page and try again.",
    schoolName: res.locals.schoolName,
  });
};

// Validates the CSRF token on state-changing requests. The token may arrive in
// the `X-CSRF-Token` header (fetch/AJAX) or the `_csrf` body field (HTML forms).
const verifyCsrf = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const expected = generateCsrfToken(req.token);
  const provided =
    req.get("x-csrf-token") ||
    req.get("x-xsrf-token") ||
    (req.body && req.body._csrf) ||
    null;

  if (expected && provided && safeEqual(expected, provided)) return next();
  return rejectCsrf(req, res);
};

module.exports = { generateCsrfToken, attachCsrfToken, verifyCsrf };
