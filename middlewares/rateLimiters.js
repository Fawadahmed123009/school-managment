/**
 * H3 — Rate limiters with proxy-safe client-key derivation.
 *
 * Two problems this module fixes (from the security audit, finding H3):
 *
 *  1. XFF BYPASS. With `app.set("trust proxy", 1)` (see app.js), express-rate-
 *     limit's default key is `req.ip`, which proxy-addr resolves from the
 *     client-supplied `X-Forwarded-For` header. A client whose socket is NOT
 *     the declared proxy (dev server, direct exposure, a proxy that forwards
 *     XFF verbatim) can rotate the limiter key at will by spoofing the
 *     header, so the login limiter never trips. Mitigations here:
 *       • `resolveClientIp` applies express's `trust proxy = n` semantics
 *         (client = chain entry at `length - n`) but ONLY while the socket
 *         peer is loopback/private (an on-box proxy). A PUBLIC socket peer
 *         can't be a co-located proxy, so its socket address is always
 *         authoritative — XFF rotation from the Internet changes nothing.
 *       • TRUST_PROXY_HOPS=0 ignores XFF completely (direct exposure).
 *       • The login budget is additionally keyed per ACCOUNT, so key
 *         rotation can never move the lockout onto (or share it with)
 *         somebody else's login attempts.
 *
 *  2. LOCKOUT. The login limiter keyed on the raw client IP only:
 *       • behind the dev internal-API loop (view POST /login → fetch to
 *         localhost) every browser presents as 127.0.0.1 — one shared bucket,
 *         so a handful of failed attempts anywhere locked out every local
 *         login;
 *       • on a shared-NAT school network one abusive/student device got the
 *         whole school locked out of the login endpoints. The old global
 *         limiter (1000/15min per key, assets included) had the same shape.
 *     Fix: login budget is keyed per {ip + account}, successful requests
 *     never consume it (skipSuccessfulRequests), and the window is short
 *     (5 min). The global limiter skips static/upload/report asset paths so
 *     normal browsing of a page (≈15 asset requests) can't exhaust it.
 *
 * Configuration (env):
 *   TRUST_PROXY_HOPS     1 (default) = one conforming front proxy (production
 *                        behind cPanel/Passenger or Cloudflare→Apache). Honors
 *                        XFF only when the socket peer is loopback/private
 *                        (an on-box proxy). 0 = no proxy: XFF never trusted.
 *   RATE_LIMIT_GLOBAL_MAX  global per-key request budget per window (default 2000)
 *   RATE_LIMIT_LOGIN_MAX   login per-{ip,account} failed-attempt budget (default 10)
 */
const rateLimit = require("express-rate-limit");
// v8 exports ipKeyGenerator from the package root (it normalizes IPv6 clients
// into a stable subnet key — plain req.ip is NOT safe to use as a bucket key).
const { ipKeyGenerator } = require("express-rate-limit");

// ── Proxy configuration ─────────────────────────────────────────
const RAW_HOPS = parseInt(process.env.TRUST_PROXY_HOPS, 10);
const TRUST_PROXY_HOPS = Number.isNaN(RAW_HOPS) ? 1 : RAW_HOPS;

/**
 * Never hand express-rate-limit a bare IPv6 address (it throws / mis-keys).
 * Loopback (the dev internal-API case) is normalized to a fixed key so the
 * account component of the login key does the actual scoping.
 */
function normalizeFamily(ip) {
  let candidate = ip === "::1" || ip === "::ffff:127.0.0.1" ? "127.0.0.1" : ip;
  candidate = typeof candidate === "string" ? candidate : "";
  // Strip the IPv4-mapped prefix so ipKeyGenerator sees a plain address.
  if (candidate.startsWith("::ffff:")) candidate = candidate.slice(7);
  if (!candidate) {
    // Unparseable (e.g. undefined) — fall back to loopback rather than crash.
    candidate = "127.0.0.1";
  }
  return candidate;
}

/**
 * Capture the RAW socket peer before anything interprets XFF. Mount FIRST
 * (before express-rate-limit) — every key decision below is made against the
 * non-spoofable socket address, never against proxy-addr's `req.ip`.
 */
function captureSocketIp(req, _res, next) {
  req.rawSocketIp = (req.socket && req.socket.remoteAddress) || "";
  next();
}

/** Loopback / RFC1918 / link-local — i.e. "a co-located front proxy". */
function isPrivateOrLoopback(ip) {
  const s = normalizeFamily(ip);
  return (
    s === "127.0.0.1" ||
    s.startsWith("127.") ||
    s.startsWith("10.") ||
    s.startsWith("192.168.") ||
    s === "0.0.0.0" ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(s)
  );
}

/**
 * Resolve the client address for limiter buckets — computed MANUALLY from the
 * XFF chain so a spoofed entry can never rotate the key:
 *   • hops = 0 — no proxy: the raw socket address IS the client, XFF ignored.
 *   • socket peer is PUBLIC — the socket is authoritative by definition (an
 *     Internet peer cannot be a co-located proxy); XFF ignored. This is the
 *     bypass fix: externally, `X-Forwarded-For` rotation changes nothing.
 *   • hops ≥ 1 and the socket is loopback/private — a conforming proxy lives
 *     on-box (cPanel/Apache, Passenger): it APPENDS the address it observed,
 *     so the client is the entry at `length - hops` (clamped to the socket
 *     when the chain is shorter than the proxy chain — pure client forgery).
 *     A LOCAL process can still forge a well-formed chain here (indistingui-
 *     shable by design — express's trust=1 has the same property); the per-
 *     {ip + account} login keying contains that: rotation can never consume
 *     or escape another account's budget.
 */
function resolveClientIp(req, hops) {
  const socketIp = req.rawSocketIp || req.socket.remoteAddress;
  if (!(hops > 0)) return socketIp;
  if (!isPrivateOrLoopback(socketIp)) return socketIp;
  const xff = req.headers["x-forwarded-for"];
  const list = (Array.isArray(xff) ? xff.join(",") : xff || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0 || list.length < hops) return socketIp || req.ip;
  return list[list.length - hops];
}

/**
 * express-rate-limit-safe bucket key (IPv6 normalized per-subnet).
 * NOTE: express-rate-limit calls keyGenerator(req, res) — never rely on a
 * default second parameter for `hops`; resolve it from the env-backed value.
 * `hopsOverride` exists for tests / explicit per-limiter policies only.
 */
function clientKey(req, hopsOverride) {
  const hops = hopsOverride === undefined ? TRUST_PROXY_HOPS : hopsOverride;
  return ipKeyGenerator(normalizeFamily(resolveClientIp(req, hops)));
}

// ── Global limiter ──────────────────────────────────────────────
const GLOBAL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const GLOBAL_MAX = parseInt(process.env.RATE_LIMIT_GLOBAL_MAX, 10) || 2000;

const globalLimiter = rateLimit({
  windowMs: GLOBAL_WINDOW_MS,
  max: GLOBAL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientKey(req),
  // Don't count static assets, cookie-gated uploads, or UUID-gated short-lived
  // PDF reports toward the per-client budget — one page load pulls ~15 assets
  // and a burst of report opens must not lock out a whole shared-NAT school.
  skip: (req) =>
    req.path.startsWith("/css/") ||
    req.path.startsWith("/js/") ||
    req.path.startsWith("/images/") ||
    req.path.startsWith("/uploads/") ||
    req.path.startsWith("/reports/pdf/") ||
    req.path.endsWith(".ico"),
  message: { status: "failed", message: "Too many requests, please try again later." },
});

// ── Login limiter (per IP + account) ────────────────────────────
const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const LOGIN_MAX = parseInt(process.env.RATE_LIMIT_LOGIN_MAX, 10) || 10;

/**
 * Account part of the login key. Available on BOTH surfaces because body
 * parsing runs before the limiters in app.js:
 *   • view form POST /login          → req.body.email
 *   • API POST /api/v1/<role>/login  → body email, else the role path segment
 * Empty → "-" keeps every account under one bucket, which is exactly the
 * non-spoofable per-IP budget.
 */
function accountKey(req) {
  const raw = (req.body && req.body.email) || "";
  const email = String(raw).trim().toLowerCase();
  if (email) return email;
  const m = req.path.match(/\/([a-z]+)\/login$/i);
  return m ? m[1].toLowerCase() : "-";
}

const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${clientKey(req)}|${accountKey(req)}`,
  // A successful login clears the bucket: the budget punishes failed guesses
  // only, so nobody can be locked out of their own account by mistyping.
  skipSuccessfulRequests: true,
  message: { status: "failed", message: "Too many login attempts, please try again later." },
});

module.exports = {
  captureSocketIp,
  resolveClientIp,
  isPrivateOrLoopback,
  globalLimiter,
  loginLimiter,
  clientKey,
  accountKey,
  normalizeFamily,
  TRUST_PROXY_HOPS,
};
