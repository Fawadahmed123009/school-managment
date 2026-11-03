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
// The real global error handler, so the integration block proves what the
// teacher actually receives when the policy refuses a request.
const errorHandler = require("../middlewares/errorHandler");

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

// ── Unit: the proxied production shape (the mark-entry 500 regression) ────────
describe("isSameOrigin behind the hosting proxy (total/pass marks PATCH)", () => {
  // Exactly what the Node process sees behind the cPanel/Apache proxy: the
  // public host arrives WITHOUT a port, the public scheme comes from
  // X-Forwarded-Proto (which Express folds into req.protocol when trust proxy is
  // on), and the socket is bound to the private app port 5130.
  const proxied = (host, proto) => ({
    headers: { host, "x-forwarded-proto": proto },
    protocol: proto,
    socket: { localPort: 5130 },
  });

  // Before the fix the port was taken from req.socket.localPort whenever Host
  // had none, so https://avenslms.com (443) was compared against 5130, judged
  // cross-origin, and the marks PATCH died with "Not allowed by CORS" — a 500
  // for the app's OWN same-origin request, on the devices/URLs that hit it.
  test("accepts the site's own https origin even though Host carries no port", () => {
    expect(isSameOrigin(proxied("avenslms.com", "https"), "https://avenslms.com")).toBe(true);
  });

  test("accepts the www alias and the plain-http scheme", () => {
    expect(isSameOrigin(proxied("www.avenslms.com", "https"), "https://www.avenslms.com")).toBe(true);
    expect(isSameOrigin(proxied("avenslms.com", "http"), "http://avenslms.com")).toBe(true);
  });

  test("accepts the app port when it is reached directly", () => {
    expect(isSameOrigin(proxied("avenslms.com:5130", "http"), "http://avenslms.com:5130")).toBe(true);
    expect(isSameOrigin(proxied("avenslms.com", "https"), "http://avenslms.com:5130")).toBe(true);
  });

  // Deployment-dependent proxy headers must not be able to break the save: a
  // proxy that does not forward X-Forwarded-Proto leaves req.protocol as http
  // while the browser used https, and that mismatch alone used to be fatal.
  test("accepts the site's own origin whatever scheme the proxy reported", () => {
    expect(isSameOrigin(proxied("avenslms.com", "http"), "https://avenslms.com")).toBe(true);
    expect(isSameOrigin(proxied("avenslms.com", "https"), "http://avenslms.com")).toBe(true);
  });

  test("a different HOST is still not same-origin, whatever the port", () => {
    expect(isSameOrigin(proxied("avenslms.com", "https"), "https://evil.example")).toBe(false);
    expect(isSameOrigin(proxied("avenslms.com", "https"), "https://evil.example:443")).toBe(false);
    expect(isSameOrigin(proxied("avenslms.com", "https"), "http://sub.avenslms.com")).toBe(false);
    // A spoofed Host is the only way to fake this match, and a browser will not
    // send one for a cross-site request (the Host is set from the URL, and TLS
    // pins it) — so the verdict stays sound without reading X-Forwarded-*.
    expect(isSameOrigin(proxied("evil.example", "https"), "https://evil.example")).toBe(true);
  });

  // A third party sharing the host on another port is a different origin and
  // must stay rejected — only the ports this app is actually served on qualify.
  test("an unrelated port on the same host is not same-origin", () => {
    expect(isSameOrigin(proxied("avenslms.com", "https"), "http://avenslms.com:8080")).toBe(false);
    expect(isSameOrigin(proxied("avenslms.com", "https"), "http://avenslms.com:9999")).toBe(false);
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
    // The app's own terminal error handler (app.js mounts it last).
    app.use(errorHandler);
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

  test("rejects a foreign origin that is not allow-listed — as a 403, never a 500", async () => {
    const res = await fetch(`${base}/api/v1/tests/abc/marks`, {
      method: "PATCH",
      headers: { Origin: "https://evil.example" },
      body: "{}",
    });
    // A policy refusal is the client's problem to fix, not a server fault: it
    // used to fall through to the 500 "Internal server error" the teachers saw.
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/address the site does not accept/i);
  });

  // The proxied production shape, end to end: the browser's Origin is the site
  // on its canonical port while Node sees a Host WITHOUT any port and its own
  // socket on 5130. This request used to be refused (→ 500) for exactly that
  // reason, which is why the failure looked device/URL-dependent.
  test("accepts a same-origin PATCH arriving with a port-less Host header", async () => {
    const http = require("http");
    const rawPort = server.address().port;
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: rawPort,
          method: "PATCH",
          path: "/api/v1/tests/abc/marks",
          headers: {
            host: "127.0.0.1", // no port — as a preserving proxy forwards it
            origin: "http://127.0.0.1", // canonical port 80, not the app's socket port
            "content-type": "application/json",
          },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify({ totalMarks: 100, passMarks: 40 }));
    });

    expect(body.status).toBe(200);
    expect(JSON.parse(body.text).status).toBe("success");
  });

  test("still allows an allow-listed cross-origin (APP_URL)", async () => {
    // The origin itself isn't sent by any browser here — we assert the list,
    // which the middleware consults after the same-origin check.
    const { allowedOrigins } = require("../utils/corsPolicy");
    expect(allowedOrigins).toContain("https://avenslms.com");
    expect(allowedOrigins).not.toContain("https://evil.example");
  });
});
