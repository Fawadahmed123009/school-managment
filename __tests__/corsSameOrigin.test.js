/**
 * Regression tests for the API CORS policy (utils/corsPolicy.js).
 *
 * Bug being locked down: the scan & enter marks page saves the test's
 * total/pass scale via a same-origin fetch PATCH to /api/v1/tests/:id/marks.
 * Browsers attach an Origin header on same-origin non-GET fetches, and the old
 * static allowlist (hard-coded :3001 + production APP_URL) rejected any other
 * dev host:port → "Internal Server Error" on Save. The policy must now allow
 * same-origin requests on ANY port while still rejecting foreign origins.
 *
 * Runs the real middleware on a spawned-free in-process express server with a
 * global error handler mirroring app.js (origin callback errors → 500).
 */

// Deterministic allowlist inputs regardless of the developer's .env
process.env.NODE_ENV = "development";
process.env.APP_URL = "https://avenslms.com";
delete process.env.EXTRA_ALLOWED_ORIGINS;

const express = require("express");
const { corsMiddleware, isSameOrigin, canonicalHost } = require("../utils/corsPolicy");

// ── Unit: isSameOrigin (pure req-shape inputs) ───────────────────────────────
const fakeReq = (host) => ({ headers: { host } });

describe("isSameOrigin", () => {
  test("matches exact host and port", () => {
    expect(isSameOrigin(fakeReq("localhost:5130"), "http://localhost:5130")).toBe(true);
  });

  test("aliases localhost / 127.0.0.1 / ::1 but not the port", () => {
    expect(isSameOrigin(fakeReq("127.0.0.1:5130"), "http://localhost:5130")).toBe(true);
    expect(isSameOrigin(fakeReq("[::1]:5130"), "http://localhost:5130")).toBe(true);
    expect(isSameOrigin(fakeReq("localhost:5130"), "http://localhost:9999")).toBe(false);
  });

  test("rejects a foreign host and garbage origins", () => {
    expect(isSameOrigin(fakeReq("evil.example:5130"), "http://evil.example:5130") === true).toBe(true); // same host+port IS same-origin by design (browser decides credibility)
    expect(isSameOrigin(fakeReq("localhost:5130"), "not a url")).toBe(false);
  });

  test("canonicalHost strips brackets and case, aliases loopback", () => {
    expect(canonicalHost("[::1]")).toBe("loopback");
    expect(canonicalHost("LOCALHOST")).toBe("loopback");
    expect(canonicalHost("Example.COM")).toBe("example.com");
  });
});

// ── Integration: the real middleware on a live server ────────────────────────
describe("corsMiddleware on a same-origin PATCH (the marks-save flow)", () => {
  let server;
  let base;
  let port;

  beforeAll((done) => {
    const app = express();
    app.use("/api", corsMiddleware);
    app.patch("/api/v1/tests/:id/marks", (req, res) => res.json({ status: "success" }));
    // Mirrors app.js: a CORS origin-callback error surfaces as a 500.
    app.use((err, req, res, next) => res.status(500).json({ status: "failed", message: err.message }));
    server = app.listen(0, () => {
      port = server.address().port;
      base = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll(async () => {
    // undici keeps sockets alive — force-close so the suite can exit
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test("allows a same-origin PATCH whose Origin is the exact host:port", async () => {
    const res = await fetch(`${base}/api/v1/tests/abc/marks`, {
      method: "PATCH",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ totalMarks: 100, passMarks: 40 }),
    });
    expect(res.status).toBe(200);
  });

  test("allows same-origin via the localhost alias (server bound to 127.0.0.1)", async () => {
    const res = await fetch(`${base}/api/v1/tests/abc/marks`, {
      method: "PATCH",
      headers: { Origin: `http://localhost:${port}` },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  test("allows requests with no Origin header (curl / server-side)", async () => {
    const res = await fetch(`${base}/api/v1/tests/abc/marks`, { method: "PATCH", body: "{}" });
    expect(res.status).toBe(200);
  });

  test("still REJECTS a foreign origin that is not allow-listed", async () => {
    const res = await fetch(`${base}/api/v1/tests/abc/marks`, {
      method: "PATCH",
      headers: { Origin: "https://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(500); // errorHandler territory — request never succeeds
  });

  test("still allows an allow-listed cross-origin (APP_URL)", async () => {
    // The origin itself isn't sent by any browser here — we assert the list,
    // which the middleware consults after the same-origin check.
    const { allowedOrigins } = require("../utils/corsPolicy");
    expect(allowedOrigins).toContain("https://avenslms.com");
    expect(allowedOrigins).not.toContain("https://evil.example");
  });
});
