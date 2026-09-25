/**
 * H4 — Async error boundary (handlers/asyncErrorBoundary.handler.js).
 *
 * The finding: Express 4 never sees a rejected promise from an async
 * handler — `next(err)` is not called, so the request hangs (until the
 * client/proxy gives up) and the rejection escapes to the process-level
 * handlers, where server.js's uncaughtException policy is exit(1).
 *
 * The pre-fix failure mode is reproduced in a CHILD PROCESS (probe below):
 * inside jest an unhandled rejection is itself reported as a test failure,
 * which would mask the very behavior being pinned. Everything else runs
 * in-process over real HTTP.
 *
 * Locked behaviors:
 *   • pre-fix: no response + process-level unhandledRejection,
 *   • post-fix: a proper error response from the global error handler,
 *   • success / next()-chaining paths untouched,
 *   • a late rejection cannot corrupt an already-sent response,
 *   • error-handling layers (arity 4) are not re-wrapped,
 *   • install is idempotent and never replaces a mounted sub-router,
 *   • the REAL app stack has no unwrapped handler left, error handler last.
 */
const express = require("express");
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const boundaryPath = path.join(__dirname, "../handlers/asyncErrorBoundary.handler.js");
const { wrapStack } = require("../handlers/asyncErrorBoundary.handler");
const installAsyncErrorBoundary = require("../handlers/asyncErrorBoundary.handler");

const WRAPPED = Symbol.for("school-mgmt.asyncBoundary");

// ── Tiny HTTP helpers (node >=18 global fetch, no supertest dependency) ──
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((r) => server.close(r)),
        get: (p) =>
          fetch(`http://127.0.0.1:${port}${p}`).then(async (res) => ({
            status: res.status,
            body: await res.text(),
          })),
      });
    });
  });
}

// A request that gives up after `ms` — used to show the pre-fix hang.
function getWithDeadline(port, p, ms) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, timeout: ms }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ hung: false, status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("deadline")));
    req.on("error", () => resolve({ hung: true }));
    req.end();
  });
}

/**
 * Run a minimal app in a child node process and return its stdout.
 * `withBoundary` decides whether the H4 installer runs before the request.
 */
const probe = (withBoundary) =>
  new Promise((resolve, reject) => {
    const code = `
      const express = require(${JSON.stringify(require.resolve("express"))});
      const http = require("http");
      const seen = [];
      process.on("unhandledRejection", (r) => seen.push("UNHANDLED_REJECTION:" + (r && r.message)));

      const app = express();
      const api = express.Router();
      api.get("/deep", async (req, res) => { throw new Error("db hiccup"); });
      app.use("/api", api);
      app.use(function (err, req, res, next) {
        res.status(500).json({ status: "failed", message: err.message });
      });
      if (${withBoundary}) require(${JSON.stringify(boundaryPath)})(app);

      const server = app.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const timer = setTimeout(() => {
          console.log("RESULT NO_RESPONSE");
          console.log(seen.join("\\n"));
          process.exit(0);
        }, 900);
        const req = http.request({ host: "127.0.0.1", port, path: "/api/deep" }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            clearTimeout(timer);
            console.log("RESULT RESPONSE " + res.statusCode + " " + body);
            console.log(seen.join("\\n"));
            process.exit(0);
          });
        });
        req.on("error", () => {});
        req.end();
      });
    `;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("close", () => (out.includes("RESULT ") ? resolve(out) : reject(new Error(out + errOut))));
  });

// App shaped like production: nested routers, then the boundary, then the
// global error handler (which is what turns next(err) into a response).
function buildApp({ installWhen = "after" } = {}) {
  const app = express();
  const api = express.Router();
  const inner = express.Router();

  inner.get("/deep", async (req, res) => {
    throw new Error("mongo server selection timed out");
  });
  inner.get("/ok", async (req, res) => {
    await Promise.resolve();
    res.json({ status: "success", data: "fine" });
  });
  inner.get("/late", async (req, res) => {
    res.json({ status: "success" });
    // Rejects AFTER the response was already sent.
    await new Promise((_, rej) => setTimeout(() => rej(new Error("late rejection")), 20));
  });
  api.use("/v1", inner);
  api.get("/sync-throw", (req, res) => {
    throw new Error("sync throw");
  });
  api.get("/next-chain", async (req, res, next) => {
    await Promise.resolve();
    next();
  });

  app.use("/api", api);
  app.get("/next-chain", (req, res) => res.json({ status: "success", reached: true }));

  if (installWhen === "before") installAsyncErrorBoundary(app);

  // Global error handler — same contract as middlewares/errorHandler.js.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) =>
    res.status(err.statusCode || 500).json({ status: "failed", message: err.message })
  );

  if (installWhen === "after") installAsyncErrorBoundary(app);
  return app;
}

// Walk a stack the way the boundary does and report handlers still exposed
// to the pre-fix gap (async handlers not behind the boundary).
const countUnwrapped = (stack) => {
  let bad = 0;
  for (const layer of stack) {
    if (layer.route) bad += countUnwrapped(layer.route.stack.map((h) => ({ handle: h.handle })));
    else if (layer.handle && Array.isArray(layer.handle.stack)) bad += countUnwrapped(layer.handle.stack);
    else if (layer.handle && layer.handle.constructor.name === "AsyncFunction" && !layer.handle[WRAPPED]) bad += 1;
  }
  return bad;
};

describe("H4 — the pre-fix failure mode vs. the boundary (child process)", () => {
  it("without the boundary: no response at all AND a process-level unhandled rejection", async () => {
    const out = await probe(false);
    expect(out).toContain("RESULT NO_RESPONSE"); // hung: express swallowed the rejection
    expect(out).toContain("UNHANDLED_REJECTION:db hiccup");
  }, 15000);

  it("with the boundary: the same rejection becomes a 500 error response, nothing escapes", async () => {
    const out = await probe(true);
    expect(out).toContain('RESULT RESPONSE 500 {"status":"failed","message":"db hiccup"}');
    expect(out).not.toContain("UNHANDLED_REJECTION");
  }, 15000);
});

describe("H4 — the boundary in-process over real HTTP", () => {
  let server;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("a rejection thrown in a nested async route handler reaches the error handler", async () => {
    server = await listen(buildApp());
    const res = await getWithDeadline(server.port, "/api/v1/deep", 1500);

    expect(res.hung).toBe(false);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      status: "failed",
      message: "mongo server selection timed out",
    });
  });

  it("works whether the boundary is installed before or after the error handler", async () => {
    server = await listen(buildApp({ installWhen: "before" }));
    const res = await getWithDeadline(server.port, "/api/v1/deep", 1500);
    expect(res.status).toBe(500);
  });

  it("a sync throw still behaves exactly as Express always did", async () => {
    server = await listen(buildApp());
    const res = await server.get("/api/sync-throw");
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).message).toBe("sync throw");
  });
});

describe("H4 — behavior preserved on the success path", () => {
  let server;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("async handler that responds is untouched", async () => {
    server = await listen(buildApp());
    const res = await server.get("/api/v1/ok");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "success", data: "fine" });
  });

  it("async middleware that awaits then calls next() still chains", async () => {
    server = await listen(buildApp());
    const res = await server.get("/next-chain");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "success", reached: true });
  });

  it("a rejection AFTER the response was sent cannot corrupt the response", async () => {
    server = await listen(buildApp());
    const res = await server.get("/api/v1/late");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "success" });
    await new Promise((r) => setTimeout(r, 80)); // let the late rejection land
  });

  it("the boundary never calls next() twice for one request", async () => {
    const app = express();
    const seen = [];
    app.use(async (req, res, next) => {
      next(new Error("first"));
      await new Promise((_, rej) => setTimeout(() => rej(new Error("second")), 10));
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
      seen.push(err.message);
      res.status(500).json({ status: "failed", message: err.message });
    });
    installAsyncErrorBoundary(app);
    server = await listen(app);

    const res = await server.get("/x");
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toEqual(["first"]); // the late rejection is dropped, not re-sent
  });
});

describe("H4 — installer semantics", () => {
  it("is idempotent: a second install wraps nothing", () => {
    const app = buildApp(); // buildApp already installed
    expect(installAsyncErrorBoundary(app)).toBe(0);
  });

  it("first install wraps every own handler (plus express's two boot layers)", () => {
    const app = express();
    const api = express.Router();
    api.get("/a", async (req, res) => res.sendStatus(200), (req, res) => res.sendStatus(200));
    api.use(async (req, res, next) => next());
    app.use("/api", api);
    expect(installAsyncErrorBoundary(app)).toBe(5);
    expect(app._router.stack.filter((l) => l.handle[WRAPPED]).length).toBe(2); // query, expressInit
    expect(api.stack[0].route.stack.filter((h) => h.handle[WRAPPED]).length).toBe(2);
    expect(api.stack[1].handle[WRAPPED]).toBe(true);
  });

  it("leaves error-handling layers (arity 4) alone", () => {
    const app = express();
    // eslint-disable-next-line no-unused-vars
    const errors = (err, req, res, _next) => res.sendStatus(500);
    app.use(errors);
    const layer = app._router.stack.find((l) => l.handle === errors);
    installAsyncErrorBoundary(app);
    expect(layer.handle).toBe(errors);
  });

  it("does not replace a mounted sub-router, only its handlers", () => {
    const app = express();
    const sub = express.Router();
    sub.get("/x", async (req, res) => res.sendStatus(200));
    app.use("/sub", sub);
    const layer = app._router.stack[app._router.stack.length - 1];
    installAsyncErrorBoundary(app);
    expect(layer.handle).toBe(sub); // same router object
    expect(layer.handle.stack[0].route.stack[0].handle[WRAPPED]).toBe(true);
  });

  it("wrapStack counts route-level handlers", () => {
    const router = express.Router();
    router.get("/a", async (req, res) => res.sendStatus(200), (req, res) => res.sendStatus(200));
    expect(wrapStack(router.stack)).toBe(2);
    expect(wrapStack(router.stack)).toBe(0);
  });
});

describe("H4 — the real application is wired", () => {
  // Requiring app/app.js mounts every API + view router AND installs the
  // boundary (app.js itself opens no DB connection).
  const app = require("../app/app");

  it("app.js installed the boundary over the whole mounted stack", () => {
    expect(countUnwrapped(app._router.stack)).toBe(0);
  });

  it("the app is async-heavy and every async handler sits behind the boundary", () => {
    const originals = [];
    const walk = (stack) => {
      for (const layer of stack) {
        if (layer.route) {
          for (const h of layer.route.stack) originals.push(h.handle);
        } else if (layer.handle && Array.isArray(layer.handle.stack)) {
          walk(layer.handle.stack);
        } else if (layer.handle) {
          originals.push(layer.handle);
        }
      }
    };
    walk(app._router.stack);

    const wrapped = originals.filter((fn) => fn[WRAPPED]);
    expect(wrapped.length).toBeGreaterThan(100);
    // Wrapped handlers keep the original name visible for debugging.
    expect(wrapped.some((fn) => /^asyncBoundary\(/.test(fn.name))).toBe(true);
    // Nothing async is left unwrapped.
    expect(originals.filter((fn) => fn.constructor.name === "AsyncFunction" && !fn[WRAPPED])).toEqual([]);
  });

  it("the global error handler is still the last mounted layer", () => {
    const last = app._router.stack[app._router.stack.length - 1];
    expect(last.handle).toBe(require("../middlewares/errorHandler"));
    expect(last.handle.length).toBe(4);
  });
});
