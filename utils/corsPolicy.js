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
 * Default port implied by a request scheme ("https", "https://", "http"…).
 */
const defaultPortFor = (scheme) => (/^https/i.test(String(scheme || "")) ? "443" : "80");

/**
 * True when the browser's Origin header points at this very server.
 *
 * The port must be resolved the way the BROWSER saw it, not the way the Node
 * process is bound. Behind the cPanel/Apache proxy in production a request
 * arrives as `Host: avenslms.com` (no port) on a socket listening on 5130 with
 * `X-Forwarded-Proto: https`, while the browser's Origin is
 * `https://avenslms.com` — port 443. Falling back to `req.socket.localPort`
 * there compared 443 against 5130, so the app's OWN same-origin PATCH (the
 * total/pass marks save on the mark-entry page) was misjudged as cross-origin
 * and rejected. That failure is inherently device-dependent — only requests
 * whose Host header carries an explicit port, and browsers that omit `Origin`
 * on same-origin non-GET requests (Safari), escaped it — which is exactly how
 * "some mobiles/laptops get an Internal Server Error when editing total marks"
 * presented.
 *
 * Accepted ports for a matching host are therefore every port this app can
 * plausibly be reached on — the one in the Host header, the two scheme defaults,
 * and the local socket port for direct access. The HOST is what makes the
 * request same-site: a browser can only ever send its own host here, and a page
 * on a different site has a different host, so it stays rejected on any port.
 * (Any other port on this host — an unrelated admin panel on :8080, say — is
 * still a distinct origin and is still rejected, because it is in none of the
 * accepted values.)
 */
const isSameOrigin = (req, origin) => {
  try {
    const o = new URL(origin);
    const originPort = o.port || defaultPortFor(o.protocol);
    // Host header forms: "example.com", "example.com:5130", "[::1]:5130", "[::1]"
    const headers = (req && req.headers) || {};
    const hostHeader = String(headers.host || "");
    const bracketEnd = hostHeader.indexOf("]");
    const reqHost = bracketEnd >= 0 ? hostHeader.slice(0, bracketEnd + 1) : hostHeader.split(":")[0];
    const rest = hostHeader.slice(reqHost.length);
    const reachablePorts = new Set(["80", "443"]);
    if (rest.startsWith(":")) reachablePorts.add(rest.slice(1));
    const localPort = req && req.socket && req.socket.localPort;
    if (localPort) reachablePorts.add(String(localPort));
    return (
      canonicalHost(o.hostname) === canonicalHost(reqHost) &&
      reachablePorts.has(String(originPort))
    );
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

module.exports = { corsMiddleware, isSameOrigin, canonicalHost, defaultPortFor, allowedOrigins };
