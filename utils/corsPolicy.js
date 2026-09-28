/**
 * CORS policy for the JSON API (mounted at /api in app/app.js).
 *
 * Kept as a standalone module so it can be unit-tested without booting the
 * full app (DB, session, rate limiters).
 *
 * Why same-origin detection matters: browsers attach an `Origin` header even
 * to SAME-origin fetch() requests that use non-GET methods (POST/PATCH/DELETE).
 * A pure static allowlist (hard-coded dev ports + production APP_URL) therefore
 * rejects the app's own UI with "Not allowed by CORS" whenever it runs on a
 * host:port that isn't literally listed — e.g. saving total/pass marks from the
 * scan & enter marks page. Same-origin requests are recognized and allowed
 * here instead of growing the allowlist per developer machine.
 */
const cors = require("cors");

const isProd = process.env.NODE_ENV === "production";
const allowedOrigins = [
  // In production, do NOT include localhost — only allow the real domain(s)
  ...(isProd ? [] : ["http://localhost:3001", "http://127.0.0.1:3001"]),
  process.env.APP_URL,
  ...(process.env.EXTRA_ALLOWED_ORIGINS ? process.env.EXTRA_ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : []),
].filter(Boolean);

/**
 * Normalize a hostname for same-origin comparison. "localhost", "127.0.0.1"
 * and "::1" are the same machine for a loopback dev server, and browsers may
 * resolve any of them — aliasing them keeps a local server on any port working
 * without hard-coding the port into the allowlist.
 */
const canonicalHost = (host) => {
  const h = (host || "").toString().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" ? "loopback" : h;
};

/**
 * True when the browser's Origin header points at this very server
 * (same protocol, host and port as the incoming request).
 */
const isSameOrigin = (req, origin) => {
  try {
    const o = new URL(origin);
    const originPort = o.port || (o.protocol === "https:" ? "443" : "80");
    // Host header forms: "example.com", "example.com:5130", "[::1]:5130", "[::1]"
    const hostHeader = String(req.headers.host || "");
    const bracketEnd = hostHeader.indexOf("]");
    const reqHost = bracketEnd >= 0 ? hostHeader.slice(0, bracketEnd + 1) : hostHeader.split(":")[0];
    const rest = hostHeader.slice(reqHost.length);
    const reqPort = rest.startsWith(":")
      ? rest.slice(1)
      : req.socket && req.socket.localPort
        ? String(req.socket.localPort)
        : req.protocol === "https:"
          ? "443"
          : "80";
    return canonicalHost(o.hostname) === canonicalHost(reqHost) && originPort === reqPort;
  } catch {
    return false;
  }
};

// cors@2.8.5 gives the origin callback no `req` — but it accepts a per-request
// OPTIONS function, so the same-origin verdict is computed there and captured.
const corsOptions = (req, cb) => {
  const sameOrigin = Boolean(req && req.headers.origin && isSameOrigin(req, req.headers.origin));
  cb(null, {
    origin: function (origin, callback) {
      // Allow requests with no origin (server-side, curl, mobile apps)
      if (!origin) return callback(null, true);
      // Same-origin browser requests are not cross-origin — always allow.
      if (sameOrigin && origin === req.headers.origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  });
};

const corsMiddleware = cors(corsOptions);

module.exports = { corsMiddleware, isSameOrigin, canonicalHost, allowedOrigins };
