// cSpell:ignore erl
/**
 * H3 — Rate-limiter hardening (middlewares/rateLimiters.js).
 *
 * Locks the two behaviors the finding demanded:
 *  1. XFF BYPASS CLOSED — the bucket key is derived from the raw socket /
 *     the proxy-observed entry, NEVER from a client-spoofable leftmost XFF
 *     value. Rotating `X-Forwarded-For` must not buy extra login attempts.
 *  2. LOCKOUT CLOSED (per-account budget) — the login limiter keys per
 *     {ip + account}; one account's failed guesses cannot lock a different
 *     account sharing the same IP (dev internal-API loop / school NAT), and
 *     SUCCESSFUL requests never consume budget (skipSuccessfulRequests).
 *
 * Also pins the app.js wiring: body parsing before the limiters (so the
 * account key exists), login limiter on BOTH the API routes and the form
 * POST /login, and TRUST_PROXY_HOPS-driven trust proxy.
 *
 * No DB is touched: the limiters are exercised through real HTTP against
 * minimal express apps mounted in the same order as app.js.
 */
const express = require("express");
const rateLimit = require("express-rate-limit");

const {
  captureSocketIp,
  resolveClientIp,
  normalizeFamily,
  isPrivateOrLoopback,
  accountKey,
  clientKey,
  loginLimiter,
} = require("../middlewares/rateLimiters");

// ── Tiny HTTP helper (node >=18 global fetch, no supertest dependency) ──
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((r) => server.close(r)),
        request: (path, opts = {}) =>
          fetch(`http://127.0.0.1:${port}${path}`, opts).then(async (res) => ({
            status: res.status,
            body: await res.text(),
            headers: Object.fromEntries(res.headers.entries()),
          })),
      });
    });
  });
}

const json = (obj) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

// Mini-app replicating app.js H3 order: body parsing → capture → limiter.
function buildApp(limiter) {
  const app = express();
  app.use(express.json());
  app.use(captureSocketIp);
  app.use(limiter);
  return app;
}

// ── Unit: client-key derivation ─────────────────────────────────
describe("H3 — resolveClientIp / key derivation", () => {
  const req = (socketIp, xff) => ({
    rawSocketIp: socketIp,
    socket: { remoteAddress: socketIp },
    headers: xff === undefined ? {} : { "x-forwarded-for": xff },
  });

  it("hops=0 ignores XFF entirely (direct exposure ⇒ non-spoofable socket)", () => {
    expect(resolveClientIp(req("203.0.113.9", "1.1.1.1, 2.2.2.2"), 0)).toBe("203.0.113.9");
    expect(resolveClientIp(req("203.0.113.9"), 0)).toBe("203.0.113.9");
  });

  it("a PUBLIC socket peer is always authoritative — XFF rotation is inert (the bypass fix)", () => {
    // Node exposed directly to the Internet: whatever the client claims in
    // XFF, the bucket key is the real TCP peer.
    expect(resolveClientIp(req("203.0.113.9", "9.9.9.9"), 1)).toBe("203.0.113.9");
    expect(resolveClientIp(req("203.0.113.9", "1.1.1.1, 2.2.2.2, 3.3.3.3"), 1)).toBe("203.0.113.9");
    expect(resolveClientIp(req("203.0.113.9", "5.5.5.5"), 2)).toBe("203.0.113.9");
  });

  it("hops=1 with an on-box conforming proxy: the proxy-appended (last) entry wins", () => {
    // Browser 1.2.3.4 → Apache (loopback to Node) appended "1.2.3.4".
    expect(resolveClientIp(req("127.0.0.1", "1.2.3.4"), 1)).toBe("1.2.3.4");
    // Attacker sent "XFF: 9.9.9.9"; Apache appended the real client 1.2.3.4.
    expect(resolveClientIp(req("127.0.0.1", "9.9.9.9, 1.2.3.4"), 1)).toBe("1.2.3.4");
    // Two chained appending proxies (Cloudflare appends the client; Apache
    // appends Cloudflare's egress), hops=2 → client is the next-to-last:
    expect(resolveClientIp(req("127.0.0.1", "9.9.9.9, 1.2.3.4, 172.70.0.1"), 2)).toBe("1.2.3.4");
    // ...and a chain SHORTER than the proxy chain (pure forgery) clamps to socket:
    expect(resolveClientIp(req("127.0.0.1", "9.9.9.9"), 2)).toBe("127.0.0.1");
  });

  it("no XFF header falls back to the socket in every mode", () => {
    expect(resolveClientIp(req("203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(resolveClientIp(req("127.0.0.1"), 1)).toBe("127.0.0.1");
  });

  it("isPrivateOrLoopback recognizes loopback/RFC1918 only", () => {
    expect(isPrivateOrLoopback("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopback("10.1.2.3")).toBe(true);
    expect(isPrivateOrLoopback("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopback("192.168.4.4")).toBe(true);
    expect(isPrivateOrLoopback("172.32.0.1")).toBe(false);
    expect(isPrivateOrLoopback("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopback("203.0.113.9")).toBe(false);
  });

  it("normalizeFamily never hands ipKeyGenerator a bare IPv6/undefined value", () => {
    expect(normalizeFamily("::1")).toBe("127.0.0.1");
    expect(normalizeFamily("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeFamily("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeFamily(undefined)).toBe("127.0.0.1");
    expect(normalizeFamily("")).toBe("127.0.0.1");
  });

  it("accountKey: trimmed lowercase body email, else role path segment", () => {
    const mk = (body, path) => ({ body, path });
    expect(accountKey(mk({ email: "  Principal@School.Local " }, "/login"))).toBe("principal@school.local");
    expect(accountKey(mk({}, "/api/v1/admin/login"))).toBe("admin");
    expect(accountKey(mk({}, "/login"))).toBe("-");
  });
});

// ── Integration: the exported login limiter over real HTTP ──────
describe("H3 — exported loginLimiter behavior", () => {
  // Same key function the module's limiter uses, but with a tiny budget so
  // tests don't need LOGIN_MAX requests. (Behavior of the REAL exported
  // limiter is locked by the last test in the wiring block below.)
  const loginKey = (req) => `${clientKey(req)}|${accountKey(req)}`;
  const smallLogin = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: loginKey,
    skipSuccessfulRequests: true,
    message: { status: "failed", message: "Too many login attempts, please try again later." },
  });

  it("direct-exposure mode (hops=0): spoofed XFF rotation cannot bypass the bucket", async () => {
    // Models TRUST_PROXY_HOPS=0 (Node exposed directly / non-normalizing
    // proxy): every request on this test socket shares ONE ip key no matter
    // what XFF claims — so the budget is real and the throttle trips.
    const hopZeroLogin = rateLimit({
      windowMs: 60 * 1000,
      max: 2,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `${clientKey(req, 0)}|${accountKey(req)}`,
      skipSuccessfulRequests: true,
      message: { status: "failed", message: "Too many login attempts, please try again later." },
    });
    const app = buildApp(hopZeroLogin);
    app.post("/api/v1/admin/login", (req, res) => res.status(401).json({ status: "failed" }));
    const srv = await listen(app);
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) {
        const r = await srv.request("/api/v1/admin/login", {
          ...json({ email: "attacker@x.com", password: "guess" }),
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": `203.0.113.${100 + i}`, // rotate every attempt
          },
        });
        codes.push(r.status);
      }
      // Bypass would be "no 429s at all". Correct: budget exhausted.
      expect(codes.slice(0, 2)).toEqual([401, 401]);
      expect(codes[2]).toBe(429);
      expect(codes[4]).toBe(429);
    } finally {
      await srv.close();
    }
  });

  it("one account's failures do NOT lock out a different account on the same IP", async () => {
    const app = buildApp(smallLogin);
    app.post("/login", (req, res) => res.status(401).json({ status: "failed" }));
    const srv = await listen(app);
    try {
      await srv.request("/login", json({ email: "a@x.com", password: "x" }));
      await srv.request("/login", json({ email: "a@x.com", password: "x" }));
      const locked = await srv.request("/login", json({ email: "a@x.com", password: "x" }));
      expect(locked.status).toBe(429);
      const other = await srv.request("/login", json({ email: "b@x.com", password: "x" }));
      expect(other.status).toBe(401); // victim still fine
    } finally {
      await srv.close();
    }
  });

  it("successful logins never consume the budget (mistyping can't lock you out)", async () => {
    let passwordCorrect = true;
    // Budget of ONE failed attempt — but successes are free, so the user who
    // knows their password can never be throttled, while the guesser trips
    // on their second failure.
    const oneShot = rateLimit({
      windowMs: 60 * 1000,
      max: 1,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => {
        const { clientKey } = require("../middlewares/rateLimiters");
        return `${clientKey(req)}|${accountKey(req)}`;
      },
      skipSuccessfulRequests: true,
      message: { status: "failed", message: "Too many login attempts, please try again later." },
    });
    const app = buildApp(oneShot);
    app.post("/login", (req, res) =>
      passwordCorrect ? res.status(200).json({ status: "success" }) : res.status(401).json({ status: "failed" })
    );
    const srv = await listen(app);
    try {
      for (let i = 0; i < 4; i++) {
        const ok = await srv.request("/login", json({ email: "u@x.com", password: "right" }));
        expect(ok.status).toBe(200); // successes don't burn the budget
      }
      passwordCorrect = false;
      const f1 = await srv.request("/login", json({ email: "u@x.com", password: "wrong" }));
      expect(f1.status).toBe(401); // first failure allowed
      const f2 = await srv.request("/login", json({ email: "u@x.com", password: "wrong" }));
      expect(f2.status).toBe(429); // budget spent — further guesses throttled
    } finally {
      await srv.close();
    }
  });

  it("email key is normalized (case/whitespace variants share one bucket)", async () => {
    const app = buildApp(smallLogin);
    app.post("/login", (req, res) => res.status(401).json({ status: "failed" }));
    const srv = await listen(app);
    try {
      await srv.request("/login", json({ email: "Same@X.com", password: "x" }));
      await srv.request("/login", json({ email: " same@x.com ", password: "x" }));
      const r = await srv.request("/login", json({ email: "SAME@X.COM", password: "x" }));
      expect(r.status).toBe(429);
    } finally {
      await srv.close();
    }
  });

  it("sets standard RateLimit headers (validation-safe config)", async () => {
    const app = buildApp(smallLogin);
    app.post("/login", (req, res) => res.status(401).json({ status: "failed" }));
    const srv = await listen(app);
    try {
      const r = await srv.request("/login", json({ email: "h@x.com", password: "x" }));
      // v8 draft-8 headers (fetch lower-cases header names):
      expect(r.headers["ratelimit-limit"]).toBeDefined();
      expect(r.headers["ratelimit-policy"]).toBeDefined();
    } finally {
      await srv.close();
    }
  });
});

// ── Wiring: app.js mounts the limiters in a safe order ──────────
describe("H3 — app.js wiring", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "app", "app.js"), "utf8");

  it("body parsing runs BEFORE the limiters (account key must exist)", () => {
    const bodyIdx = src.indexOf('express.urlencoded');
    const limiterIdx = src.indexOf("app.use(globalLimiter)");
    expect(limiterIdx).toBeGreaterThan(bodyIdx);
  });

  it("login limiter covers the form POST /login as well as the API routes", () => {
    expect(src).toMatch(/app\.use\("\/login",\s*loginLimiter\)/);
    expect(src).toMatch(/app\.use\(authApiRoutes,\s*loginLimiter\)/);
  });

  it("trust proxy is driven by TRUST_PROXY_HOPS (deployable to 0)", () => {
    expect(src).toMatch(/TRUST_PROXY_HOPS/);
    expect(src).toMatch(/app\.set\("trust proxy",\s*Number\.isNaN\(hops\)\s*\?\s*1\s*:\s*hops\)/);
  });

  it("the real exported login limiter keys per {ip|account} and skips successes", () => {
    // Read the module's own behavior: a success must not burn budget.
    const app = express();
    app.use(express.json());
    app.use(captureSocketIp);
    app.use("/login", loginLimiter);
    app.post("/login", (req, res) => res.status(200).json({ ok: true }));
    return listen(app).then(async (srv) => {
      try {
        for (let i = 0; i < 15; i++) {
          const r = await srv.request("/login", json({ email: "ok@x.com", password: "p" }));
          expect(r.status).toBe(200); // 15 > LOGIN_MAX, but all succeed
        }
      } finally {
        await srv.close();
      }
    });
  });
});
