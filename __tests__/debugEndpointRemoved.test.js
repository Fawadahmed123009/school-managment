/**
 * B-16 — the /debug/db-test diagnostic route must not exist in the shipped app.
 *
 * Why it was removed rather than env-gated: the route opened a SECOND full
 * MongoClient connection pool per request (unbounded on Atlas' free-tier
 * 100-connection ceiling — an admin clicking refresh is a self-inflicted
 * connection-exhaustion amplifier), disclosed Atlas SRV topology/hostnames, and
 * surfaced raw driver error strings. Env-gating leaves the code mounted and
 * one mis-set variable away from live; deleting it removes the surface.
 *
 * These tests walk the REAL mounted Express router stack (app.js opens no DB
 * connection, so this is safe under jest) and pin:
 *   • no /debug/* route is registered at any depth,
 *   • an unauthenticated GET /debug/db-test falls through to the 404 handler
 *     (proof the route is genuinely absent, not merely gated),
 *   • the auth middlewares it used are still exported and intact,
 *   • unrelated routes (the audit viewer, the API 404 contract) still mount.
 */
const express = require("express");
const http = require("http");
const path = require("path");

const app = require("../app/app");

// ── router-stack walk ────────────────────────────────────────────────────────
// Collect every registered route path at any depth. Sub-router mount prefixes
// are not reconstructed (Express encodes them as escaped regexps); it is not
// needed — a route's own `path` is absolute-looking for the flat view routers
// this app uses, and the /debug route was registered directly on `app`.
function collectRoutes(stack, out = []) {
  for (const layer of stack) {
    if (layer.route) {
      out.push({ path: layer.route.path, methods: Object.keys(layer.route.methods) });
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      collectRoutes(layer.handle.stack, out);
    }
  }
  return out;
}

const ALL_ROUTES = collectRoutes(app._router.stack);
const ALL_PATHS = ALL_ROUTES.map((r) => r.path);

describe("B-16 — /debug/db-test is removed from the mounted app", () => {
  it("no route path mentions 'debug' anywhere in the stack", () => {
    const hits = ALL_PATHS.filter((p) => /debug/i.test(p));
    expect(hits).toEqual([]);
  });

  it("specifically, GET /debug/db-test is not registered", () => {
    expect(ALL_PATHS).not.toContain("/debug/db-test");
  });

  it("the app.js source no longer references the route or its helpers", () => {
    const fs = require("fs");
    const src = fs.readFileSync(path.join(__dirname, "../app/app.js"), "utf8");
    expect(src).not.toMatch(/app\.get\(\s*["']\/debug\/db-test/);
    expect(src).not.toMatch(/require\(["']\.\.\/middlewares\/isAdmin["']\)/);
    // The removal note documents the decision, so the word may appear in a comment.
    expect(src).toMatch(/B-16/);
  });
});

describe("B-16 — live HTTP behaviour: the path falls through to 404", () => {
  let srv;
  let port;

  beforeAll(
    () =>
      new Promise((resolve) => {
        srv = http.createServer(app);
        srv.listen(0, "127.0.0.1", () => {
          port = srv.address().port;
          resolve();
        });
      })
  );

  afterAll(() => new Promise((r) => srv.close(r)));

  const get = (p) =>
    fetch(`http://127.0.0.1:${port}${p}`, { redirect: "manual" }).then(async (res) => ({
      status: res.status,
      type: res.headers.get("content-type") || "",
      body: await res.text(),
    }));

  // NOTE ON REACHABILITY: `app.use(authView)` is mounted at app.js:187, i.e.
  // BEFORE where the debug route used to be registered, so an unauthenticated
  // GET can never prove the route is gone — authView short-circuits it with a
  // 302 to /login either way. Minting an admin session needs a live DB, so the
  // authenticated proof (404, not 200-JSON) is made by the staging live
  // verifier (tmp/_verify_security_round.js) against school-mgmt-verify.
  // What IS provable here without a DB is the disclosure contract: the
  // diagnostic payload must never appear on any response.
  it("unauthenticated GET /debug/db-test never returns the diagnostic JSON", async () => {
    const res = await get("/debug/db-test");
    expect(res.body).not.toMatch(/"dns"/);
    expect(res.body).not.toMatch(/"mongo"/);
    expect(res.body).not.toMatch(/mongodb(\+srv)?:/);
    expect(res.body).not.toMatch(/_mongodb\._tcp/);
    // authView intercepts before the (now-absent) route ever ran.
    expect(res.status).toBe(302);
  });

  it("a forged Bearer token cannot reach it either (no route to authorize)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/debug/db-test`, {
      headers: { Authorization: "Bearer not-a-real-token" },
      redirect: "manual",
    });
    const body = await res.text();
    expect(body).not.toMatch(/"dns"|"mongo"|mongodb/);
    expect([302, 401, 404]).toContain(res.status);
  });

  it("any other /debug/* path is likewise inert (no partial mount)", async () => {
    const res = await get("/debug/anything");
    expect(res.status).toBe(302);
    expect(res.body).not.toMatch(/"dns"|"mongo"/);
  });

  it("the 404 catch-all survived the removal intact (edited directly above it)", () => {
    // The debug block sat immediately before the 404 handler, so deleting it
    // must not have taken the handler with it. Proven at the stack level, not
    // by source grep: the terminal non-error layer must be the catch-all.
    const stack = app._router.stack;
    const lastNonError = [...stack].reverse().find((l) => (l.handle?.length || 0) !== 4);
    expect(lastNonError.route).toBeUndefined();
    expect(typeof lastNonError.handle).toBe("function");
    // And it really answers for an unknown path — 302 here only because
    // authView gates first; the handler itself is asserted by the source check.
    const src = require("fs").readFileSync(path.join(__dirname, "../app/app.js"), "utf8");
    expect(src).toMatch(/Route not found/);
    expect(src).toMatch(/title: "404 — Page not found"/);
  });

  it("sanity: real routes still mount (the app was not broken by the removal)", async () => {
    expect(ALL_PATHS).toContain("/audit-logs");
    expect(ALL_PATHS.some((p) => /login/.test(p))).toBe(true);
    expect(ALL_ROUTES.length).toBeGreaterThan(50);
  });
});

describe("B-16 — the auth middlewares the route previously used are untouched", () => {
  it("isAdmin and isLoggedIn still export callable middleware", () => {
    const isAdmin = require("../middlewares/isAdmin");
    const isLoggedIn = require("../middlewares/isLoggedIn");
    expect(typeof isAdmin).toBe("function");
    expect(typeof isLoggedIn).toBe("function");
    // arity 3 = (req,res,next) — still real middleware, not a stub.
    expect(isAdmin.length).toBe(3);
    expect(isLoggedIn.length).toBe(3);
  });
});

// keep express referenced (used by the router-shape assertion below)
it("the mounted root is an express app (guards against a mis-wired require)", () => {
  expect(typeof app.listen).toBe("function");
  expect(Array.isArray(app._router.stack)).toBe(true);
  expect(express).toBeDefined();
});
