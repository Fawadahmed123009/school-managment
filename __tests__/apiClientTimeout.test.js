/**
 * A-4 — utils/apiClient.js gains an OPT-IN request deadline.
 *
 * The defect this exists to close: a view route awaits an internal HTTP call to
 * its own API. Under load that call could hang, the route never answered the
 * browser, and a teacher submitting attendance got no confirmation, no error and
 * no saved record. Aborting converts that into the `{status:"failed"}` shape
 * every calling view route already renders as a readable banner.
 *
 * The other half of the contract matters just as much on a production system:
 * apiFetch has ~101 call sites and this change MUST NOT alter any of them that
 * does not ask for a timeout. So the "no timeoutMs" cases below are not filler —
 * they are the regression guard for the shared util.
 *
 * Real sockets, real aborts, no response mocks: a timeout that is simulated
 * proves nothing. ONE server for the whole file on ONE port, because closing and
 * restarting let the OS reuse the port while undici kept a pooled dead socket for
 * that origin — which surfaces as an unrelated-looking "fetch failed".
 */
const http = require("http");

let server;
let port;

/**
 * Path-addressed behaviours. `/hang` never answers, which is the only faithful
 * way to exercise both the abort and (by its absence) the no-deadlet path.
 */
const BEHAVIOUR = {
  "/hang": () => { /* deliberately never respond */ },
  "/json": (req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "success", data: { ok: true } }));
  },
  "/html502": (req, res) => {
    res.statusCode = 502;
    res.setHeader("content-type", "text/html");
    res.end("<html>bad gateway</html>");
  },
};

beforeAll(
  () =>
    new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const path = String(req.url || "").split("?")[0];
        (BEHAVIOUR[path] || BEHAVIOUR["/json"])(req, res);
      });
      server.listen(0, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    })
);

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/**
 * apiClient freezes BASE_URL at require time, so each case needs a fresh module
 * with INTERNAL_API_URL pointed at this suite's server.
 *
 * jest.resetModules() is REQUIRED here: `delete require.cache[...]` is a no-op
 * under jest, because require() goes through jest's own module registry. Using
 * the bare-Node idiom silently returned the first-loaded module with the first
 * BASE_URL baked in — which made a "connection refused" case actually re-query
 * the still-running hang server and time out. The assertion that a refused port
 * answers in well under the timeout is what catches that class of mistake.
 */
async function againstServerAt(baseUrl, fn) {
  const prev = process.env.INTERNAL_API_URL;
  jest.resetModules();
  process.env.INTERNAL_API_URL = baseUrl;
  try {
    return await fn(require("../utils/apiClient"));
  } finally {
    if (prev === undefined) delete process.env.INTERNAL_API_URL;
    else process.env.INTERNAL_API_URL = prev;
  }
}

const againstThisServer = (fn) => againstServerAt(`http://127.0.0.1:${port}`, fn);

/** Settles to {settled:false} while `promise` is still pending after `ms`. */
const race = (promise, ms) =>
  Promise.race([
    promise.then(
      (value) => ({ settled: true, value }),
      (error) => ({ settled: true, error })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), ms)),
  ]);

describe("apiFetch timeoutMs — the hung internal call now terminates", () => {
  test("a request that never answers is aborted and phrased for the user", async () => {
    const t0 = Date.now();
    const out = await againstThisServer(({ apiFetch }) =>
      apiFetch("/hang", "tok", { method: "POST", body: "{}", timeoutMs: 300 })
    );
    const elapsed = Date.now() - t0;

    expect(out.status).toBe("failed");
    expect(out.message).toMatch(/did not respond within/);
    // Actually aborted on schedule — not merely a slow success.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
  }, 15000);

  test("the wording never claims the save failed — an abort does not roll back", async () => {
    const out = await againstThisServer(({ apiFetch }) =>
      apiFetch("/hang", "tok", { method: "POST", body: "{}", timeoutMs: 250 })
    );
    // The API may still finish the write after we stop waiting for it. Wording
    // that asserts failure would send the teacher to re-submit and double-record
    // the whole class, so this is a behavioural assertion, not a style check.
    expect(out.message).not.toMatch(/was not saved|failed to save|could not be saved/i);
    expect(out.message).toMatch(/may still have been saved/i);
  }, 15000);

  test("timeoutMs is consumed by apiFetch and never forwarded into fetch's init", async () => {
    let seenInit = null;
    const realFetch = global.fetch;
    global.fetch = (url, init) => {
      seenInit = init;
      return realFetch(url, init);
    };
    try {
      const out = await againstThisServer(({ apiFetch }) =>
        apiFetch("/json", "tok", { method: "POST", body: "{}", timeoutMs: 5000 })
      );
      expect(out.status).toBe("success");
      expect(seenInit).toBeTruthy();
      expect("timeoutMs" in seenInit).toBe(false);
      expect(seenInit.signal).toBeInstanceOf(AbortSignal);
      // The documented headers must survive the options rebuild.
      expect(seenInit.headers.Authorization).toBe("Bearer tok");
      expect(seenInit.headers["Content-Type"]).toBe("application/json");
    } finally {
      global.fetch = realFetch;
    }
  }, 15000);
});

describe("apiFetch with a caller-supplied signal — composition, not replacement", () => {
  test("the caller's signal still cancels once a deadline is armed", async () => {
    let seenInit = null;
    const realFetch = global.fetch;
    global.fetch = (url, init) => {
      seenInit = init;
      return realFetch(url, init);
    };
    const ac = new AbortController();
    try {
      await againstThisServer(({ apiFetch }) =>
        apiFetch("/json", "tok", { signal: ac.signal, timeoutMs: 5000 })
      );
      expect(seenInit.signal).toBeInstanceOf(AbortSignal);
      ac.abort();
      // If the deadline had REPLACED the caller's signal, this stays false and
      // the caller has silently lost the ability to cancel.
      expect(seenInit.signal.aborted).toBe(true);
    } finally {
      global.fetch = realFetch;
    }
  }, 15000);

  test("a deliberate caller abort is NOT reported as a server timeout", async () => {
    // Measured on Node 22: AbortSignal.timeout raises TimeoutError, a caller
    // abort() raises AbortError. Conflating them tells a user the server is slow
    // when in fact the request was cancelled on purpose.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const out = await againstThisServer(({ apiFetch }) =>
      apiFetch("/hang", "tok", { method: "GET", signal: ac.signal, timeoutMs: 5000 })
    );
    expect(out.status).toBe("failed");
    expect(out.message).not.toMatch(/did not respond within/);
    expect(out.message).toMatch(/Request to \/hang failed/);
  }, 15000);

  test("a runtime without AbortSignal.any degrades instead of throwing", async () => {
    // Found during the pre-deploy dry run: the host runs a Node 20 venv and
    // AbortSignal.any only exists from 20.3.0. Calling it unguarded would raise
    // "AbortSignal.any is not a function" from inside the A-4 fix itself.
    // Node 22 has it, so the older runtime is simulated by removing it.
    const real = AbortSignal.any;
    const realFetch = global.fetch;
    let seenInit = null;
    global.fetch = (url, init) => {
      seenInit = init;
      return new Promise(() => {}); // never settles, like the hang endpoint
    };
    const ac = new AbortController();
    let apiFetch = null;
    try {
      await againstThisServer(({ apiFetch: f }) => {
        apiFetch = f;
        return "module loaded";
      });
      delete AbortSignal.any;
      expect(typeof AbortSignal.any).toBe("undefined");

      // NOT awaited on purpose: with no composition primitive the correct
      // behaviour is the pre-A-4 uncapped request, i.e. still in flight. If the
      // code called AbortSignal.any blindly, apiFetch's own catch would turn
      // that TypeError into an immediate settled "failed" result.
      const pending = apiFetch("/json", "tok", { signal: ac.signal, timeoutMs: 5000 });
      const outcome = await race(pending, 400);
      expect(outcome.settled).toBe(false);
      // The caller's signal survives: its cancel ability is never silently lost.
      expect(seenInit.signal).toBe(ac.signal);
      ac.abort();
    } finally {
      if (typeof real === "function") AbortSignal.any = real;
      global.fetch = realFetch;
    }
  }, 15000);
});

describe("apiFetch without timeoutMs — the ~100 existing call sites are untouched", () => {
  test("NO signal is installed when timeoutMs is absent, and the call still hangs", async () => {
    let seenInit = null;
    const realFetch = global.fetch;
    global.fetch = (url, init) => {
      seenInit = init;
      return realFetch(url, init);
    };
    try {
      const p = againstThisServer(({ apiFetch }) =>
        apiFetch("/hang", "tok", { method: "GET" })
      );
      const raced = await race(p, 700);
      // Unresolved ON PURPOSE: this is the pre-existing behaviour, preserved for
      // every caller that did not ask for a deadline.
      expect(raced.settled).toBe(false);
      expect(seenInit).toBeTruthy();
      expect(seenInit.signal).toBeUndefined();
    } finally {
      global.fetch = realFetch;
    }
  }, 15000);

  test("timeoutMs <= 0 and non-numbers mean 'no deadline', not 'abort immediately'", async () => {
    for (const bad of [0, -1, undefined, null, NaN, "300"]) {
      let seenInit = null;
      const realFetch = global.fetch;
      global.fetch = (url, init) => {
        seenInit = init;
        return realFetch(url, init);
      };
      try {
        await againstThisServer(async ({ apiFetch }) => {
          const settled = await race(apiFetch("/hang", "tok", { method: "GET", timeoutMs: bad }), 400);
          expect(settled.settled).toBe(false);
          expect(seenInit.signal).toBeUndefined();
        });
      } finally {
        global.fetch = realFetch;
      }
    }
  }, 30000);
});

describe("apiFetch success and non-JSON paths — unchanged", () => {
  test("a normal JSON envelope is returned verbatim, timeout armed", async () => {
    const out = await againstThisServer(({ apiFetch }) =>
      apiFetch("/json", "tok", { timeoutMs: 5000 })
    );
    expect(out).toEqual({ status: "success", data: { ok: true } });
  }, 15000);

  test("an HTML reply still reports status + path, exactly as before", async () => {
    const out = await againstThisServer(({ apiFetch }) =>
      apiFetch("/html502", "tok", { method: "POST", body: "{}", timeoutMs: 5000 })
    );
    expect(out.status).toBe("failed");
    expect(out.message).toMatch(/Unexpected response \(502\) from \/html502/);
  }, 15000);

  test("a refused connection phrases as a connection failure, not a timeout", async () => {
    // Port 1 is closed. ECONNREFUSED must not be mislabelled "did not respond",
    // or every offline teacher would be told the server is merely slow.
    // The elapsed bound is also the guard that this call really did go to a
    // different origin rather than reusing a stale BASE_URL (see againstServerAt).
    const t0 = Date.now();
    const out = await againstServerAt("http://127.0.0.1:1", ({ apiFetch }) =>
      apiFetch("/hang", "tok", { method: "POST", body: "{}", timeoutMs: 5000 })
    );
    expect(out.status).toBe("failed");
    expect(out.message).toMatch(/Request to \/hang failed/);
    expect(out.message).not.toMatch(/did not respond within/);
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 15000);
});
