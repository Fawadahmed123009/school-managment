/**
 * A-1 — MongoDB connection pool configuration.
 *
 * Two independent things must hold, and they are proved differently:
 *
 *   1. config/dbConnect.js passes maxPoolSize / minPoolSize / waitQueueTimeoutMS
 *      to mongoose.connect(). This is asserted STRUCTURALLY against the source,
 *      because requiring that file would run dbConnect() for real (it is a
 *      module side effect) and open a live Atlas connection inside jest — the
 *      .env DB points at production from this box, so requiring it is not an
 *      option. Whether the values actually reach the driver is proved by the
 *      runtime check in tmp/_verify_a1_pool.js instead.
 *
 *   2. When the pool IS exhausted, the request must now produce a clear, safe
 *      error instead of hanging. Before A-1 waitQueueTimeoutMS defaulted to 0
 *      (unbounded), so this error could not even exist — overflowing requests
 *      held their socket until the proxy gave up, and the client saw nothing.
 *      Exercised over real HTTP through the actual errorHandler, following the
 *      app.use(errorHandler) pattern established in corsSameOrigin.test.js.
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const errorHandler = require("../middlewares/errorHandler");

const SRC = path.join(__dirname, "..", "config", "dbConnect.js");
const src = () => fs.readFileSync(SRC, "utf8");

// ── 1. the configuration itself ──────────────────────────────────────────────
describe("A-1 — dbConnect passes explicit pool options to mongoose.connect", () => {
  test("connect() is called with an options object, not the bare URI", () => {
    // The pre-A-1 shape was `mongoose.connect(process.env.DB)` — pin that it is
    // gone, not merely that some options exist somewhere in the file.
    expect(src()).toMatch(/mongoose\.connect\(\s*process\.env\.DB\s*,\s*\w+\s*\)/);
    expect(src()).not.toMatch(/mongoose\.connect\(\s*process\.env\.DB\s*\)/);
  });

  test("all three named options are present", () => {
    for (const key of ["maxPoolSize", "minPoolSize", "waitQueueTimeoutMS"]) {
      expect(src()).toMatch(new RegExp(`${key}\\s*:`));
    }
  });

  test("waitQueueTimeoutMS is finite and non-zero (0 means unbounded — the bug)", () => {
    const opts = src().match(/const POOL_OPTIONS = \{([\s\S]*?)\};/);
    expect(opts).not.toBeNull();
    const wait = Number(opts[1].match(/waitQueueTimeoutMS\s*:\s*(\d+)/)[1]);
    expect(wait).toBeGreaterThan(0);
    // Lower bound is a measured full Atlas TLS+auth handshake (~838 ms). Setting
    // it below that makes mongoose.connect() itself fail, so "fail fast" cannot
    // mean "fail immediately". See tmp/_probe_pool_overflow*.js.
    expect(wait).toBeGreaterThanOrEqual(2000);
    // Upper bound: must stay inside a typical 30–60 s proxy timeout so the app,
    // not the proxy, decides the outcome and the client gets a real message.
    expect(wait).toBeLessThanOrEqual(10000);
  });

  test("minPoolSize <= maxPoolSize, or the driver rejects the config", () => {
    const body = src().match(/const POOL_OPTIONS = \{([\s\S]*?)\};/)[1];
    const num = (k) => Number(body.match(new RegExp(`${k}\\s*:\\s*(\\d+)`))[1]);
    expect(num("minPoolSize")).toBeLessThanOrEqual(num("maxPoolSize"));
  });

  test("maxPoolSize stays a small share of the measured 500-connection ceiling", () => {
    const body = src().match(/const POOL_OPTIONS = \{([\s\S]*?)\};/)[1];
    const max = Number(body.match(/maxPoolSize\s*:\s*(\d+)/)[1]);
    // The cluster ceiling was measured (serverStatus: 15 in use + 485 available).
    // maxPoolSize is PER replica-set member and this set has 3 members, so the
    // worst case a single process can open is 3 × max.
    const MEMBERS = 3;
    const ceiling = 500;
    expect(max * MEMBERS / ceiling).toBeLessThanOrEqual(0.2);
  });

  test("maxPoolSize is deliberately BELOW the 100 driver default it replaced", () => {
    // Guards against a well-meant "restore performance" bump back to 100.
    // The default was 100 per member because mongoose 7.8.11 passes no
    // maxPoolSize at all — measured live, not read from docs. A measured sweep
    // (tmp/_probe_pool_size_sweep.js: same sorted 400-doc attendance read at
    // 40-way concurrency) gave 1390 / 1429 / 1397 ms for 10 / 25 / 100 with 0
    // rejections at every size, so pool size does not bound throughput here and
    // 100 only spent connection budget (300 of 500 worst case).
    const body = src().match(/const POOL_OPTIONS = \{([\s\S]*?)\};/)[1];
    const max = Number(body.match(/maxPoolSize\s*:\s*(\d+)/)[1]);
    const DRIVER_DEFAULT_PER_MEMBER = 100;
    expect(max).toBeLessThan(DRIVER_DEFAULT_PER_MEMBER);
    // ...while still clearing the concurrency that was actually measured healthy.
    expect(max).toBeGreaterThanOrEqual(25);
  });

  test("the reasoning is documented, not just the numbers", () => {
    // Required by the task: values must be justified in the file itself.
    const commentBlock = src().slice(0, src().indexOf("const POOL_OPTIONS"));
    expect(commentBlock.length).toBeGreaterThan(1500);
    for (const fact of ["500", "838", "waitQueueTimeoutMS", "maxPoolSize", "minPoolSize"]) {
      expect(commentBlock).toContain(fact);
    }
  });
});

// ── 2. overflow now produces a clear, safe error ─────────────────────────────
// Shape captured from a forced real overflow (tmp/_probe_pool_overflow4.js):
//   name    = "MongoWaitQueueTimeoutError"
//   message = "Timed out while checking out a connection from connection pool"
//   address = "ac-…-shard-00-01.nrinqhy.mongodb.net:27017"   ← internal topology
//   no statusCode / no status  → previously fell through to the generic 500
const mkOverflowError = () => {
  const err = new Error("Timed out while checking out a connection from connection pool");
  err.name = "MongoWaitQueueTimeoutError";
  err.address = "ac-qlzgiu6-shard-00-01.nrinqhy.mongodb.net:27017";
  return err;
};

describe("A-1 — pool overflow maps to a clear 503 through the real errorHandler", () => {
  let server, base;

  beforeAll((done) => {
    const app = express();
    // Mount the REAL view engine and views directory. Without it the HTML branch
    // of errorHandler (`res.render("error")`) throws for want of an engine, the
    // last-resort catch converts that to a 500 JSON, and the test measures its
    // own scaffolding instead of the app. error.ejs needs only title, message
    // and schoolName, all three of which errorHandler already passes.
    app.set("view engine", "ejs");
    app.set("views", path.join(__dirname, "..", "views"));
    app.get("/json-client", (req, res, next) => next(mkOverflowError()));
    app.get("/browser-page", (req, res, next) => next(mkOverflowError()));
    app.use(errorHandler);
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  test("an AJAX/fetch client gets 503, not 500", async () => {
    const res = await fetch(`${base}/json-client`, { headers: { Accept: "application/json" } });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/busy/i);
  });

  test("the message says the write did NOT happen (no false success)", async () => {
    // This is the A-4 "false success" class: a teacher must never be left
    // guessing whether the save landed.
    const res = await fetch(`${base}/json-client`, { headers: { Accept: "application/json" } });
    const body = await res.json();
    expect(body.message.toLowerCase()).toContain("not saved");
  });

  test("a browser page also gets 503 and a retryable message", async () => {
    const res = await fetch(`${base}/browser-page`, { headers: { Accept: "text/html" } });
    expect(res.status).toBe(503);
    const html = await res.text();
    // Rendered through the portal's real error page, not a raw JSON blob.
    expect(html).toContain("Something went wrong");
    expect(html).toContain("try again");
  });

  test("the internal Atlas hostname never reaches the client", async () => {
    // err.address holds a shard hostname, and in development the default branch
    // echoes err.message verbatim — so the branch must use fixed wording.
    for (const url of ["/json-client", "/browser-page"]) {
      const res = await fetch(`${base}${url}`, { headers: { Accept: url === "/json-client" ? "application/json" : "text/html" } });
      const text = await res.text();
      expect(text).not.toMatch(/nrinqhy|mongodb\.net|shard-00|27017/);
    }
  });

  test("a 503 is distinguishable from a real server fault by status alone", async () => {
    // Ops value: alerting can key on 503 = load, 500 = bug. Assert the two are
    // not collapsed into one code.
    const overflow = await fetch(`${base}/json-client`, { headers: { Accept: "application/json" } });
    expect(overflow.status).toBe(503);

    const app2 = express();
    app2.get("/boom", (req, res, next) => next(new Error("some genuine bug")));
    app2.use(errorHandler);
    const s2 = app2.listen(0);
    await new Promise((r) => s2.once("listening", r));
    const genuine = await fetch(`http://127.0.0.1:${s2.address().port}/boom`, { headers: { Accept: "application/json" } });
    expect(genuine.status).toBe(500);
    s2.closeAllConnections();
    s2.close();
  });
});

// ── 3. the mapping must not depend on instanceof ─────────────────────────────
describe("A-1 — mapping keys on err.name because two driver copies coexist", () => {
  test("the app's mongodb and mongoose's bundled mongodb are different modules", () => {
    // Verified live: top-level mongodb@6.1.0 vs mongoose/node_modules/mongodb@5.9.2,
    // with different require.resolve paths. Errors raised through mongoose
    // therefore come from the nested class, so `instanceof MongoDriverError`
    // imported from the top-level package is FALSE for them — matching on the
    // class identity would silently miss every real overflow.
    const top = require.resolve("mongodb");
    const nested = require.resolve("mongoose/node_modules/mongodb");
    expect(top).not.toBe(nested);
  });

  test("the handler does not use instanceof against the top-level driver", () => {
    const handlerSrc = fs.readFileSync(path.join(__dirname, "..", "middlewares", "errorHandler.js"), "utf8");
    expect(handlerSrc).toContain('err.name === "MongoWaitQueueTimeoutError"');
    expect(handlerSrc).not.toMatch(/instanceof\s+Mongo\w*Error/);
  });
});
