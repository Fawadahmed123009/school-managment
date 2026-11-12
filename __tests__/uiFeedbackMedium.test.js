/**
 * Batch 2 (Medium-severity) UI-feedback fixes — server half.
 *
 * M4: the global error handler used to answer EVERY uncaught error with raw
 * JSON, so a native form POST that threw landed the user on a JSON text page.
 * It now renders the friendly error.ejs for browser requests (explicit
 * Accept: text/html, non-API, non-XHR) while the JSON envelope stays
 * byte-identical for API/fetch clients — every status/message mapping below
 * is asserted on BOTH channels. Also: fees.views.js POST /fees/create
 * resolved the fee head OUTSIDE its try/catch; a DB hiccup there must
 * redirect with the reason, not escape as a 500.
 *
 * UI/feedback-layer only — no validation or business rule is changed.
 */

const express = require("express");
const path = require("path");
const errorHandler = require("../middlewares/errorHandler");

// ── Part A: real HTTP against the real error handler ────────────────────────

function buildApp() {
  const app = express();
  // Same view setup as app/app.js so the HTML backstop renders the REAL
  // error.ejs (without it, render throws and the last-resort JSON fallback
  // answers — which is itself the safety net this suite relies on).
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const named = (name, extra) => Object.assign(new Error(extra.message || name), { name }, extra);
  app.get("/boom", (req, res, next) => next(new Error("db hiccup")));
  app.post("/form-boom", (req, res, next) => next(new Error("save blew up")));
  app.get("/bad-request", (req, res, next) => {
    const e = new Error("Amount must be positive");
    e.statusCode = 400;
    next(e);
  });
  app.get("/validation", (req, res, next) =>
    next(named("ValidationError", { message: "Validation failed", errors: { amount: { message: "Amount is required" } } })));
  app.get("/cast", (req, res, next) =>
    next(named("CastError", { message: "cast failed", path: "_id", value: "xyz" })));
  app.get("/parse-fail", (req, res, next) =>
    next(Object.assign(new Error("bad json"), { type: "entity.parse.failed" })));
  app.get("/too-large", (req, res, next) =>
    next(Object.assign(new Error("too big"), { type: "entity.too.large" })));
  app.get("/dup", (req, res, next) =>
    next(Object.assign(new Error("dup"), { code: 11000, keyValue: { email: 1 } })));
  app.get("/multer-big", (req, res, next) =>
    next(named("MulterError", { message: "File too large", code: "LIMIT_FILE_SIZE", field: "image" })));
  app.get("/multer-field", (req, res, next) =>
    next(named("MulterError", { message: "Unexpected field", code: "LIMIT_UNEXPECTED_FILE", field: "evil" })));
  app.get("/jwt", (req, res, next) => next(named("JsonWebTokenError", { message: "jwt malformed" })));
  app.get("/cors", (req, res, next) => next(new Error("Not allowed by CORS")));
  app.get("/api/v1/boom", (req, res, next) => next(new Error("api boom")));
  app.post("/echo", (req, res) => res.json({ status: "success" }));

  app.use(errorHandler);
  return app;
}

let server;
let base;
beforeAll(async () => {
  server = buildApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const hit = (path, { method = "GET", accept, contentType, body, xhr } = {}) => {
  const headers = {};
  if (accept) headers.Accept = accept;
  if (contentType) headers["Content-Type"] = contentType;
  if (xhr) headers["X-Requested-With"] = "XMLHttpRequest";
  return fetch(base + path, { method, headers, body, redirect: "manual" }).then(async (res) => ({
    status: res.status,
    type: res.headers.get("content-type") || "",
    text: await res.text(),
  }));
};
const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("M4 — error handler answers browsers with the friendly page", () => {
  test("5xx on a browser request renders error.ejs, never the raw engine message", async () => {
    const r = await hit("/boom", { accept: HTML });
    expect(r.status).toBe(500);
    expect(r.type).toContain("text/html");
    expect(r.text).toContain("Something went wrong");
    expect(r.text).toContain("go back and try again");
    expect(r.text).not.toContain("db hiccup");
    expect(r.text).toContain("Back to dashboard");
  });

  test("native form POST (urlencoded + Accept html) gets the page, not JSON", async () => {
    const r = await hit("/form-boom", {
      method: "POST",
      accept: HTML,
      contentType: "application/x-www-form-urlencoded",
      body: "amount=5",
    });
    expect(r.status).toBe(500);
    expect(r.type).toContain("text/html");
    expect(r.text).toContain("Something went wrong");
  });

  test("4xx on a browser request shows the actionable reason", async () => {
    const r = await hit("/bad-request", { accept: HTML });
    expect(r.status).toBe(400);
    expect(r.type).toContain("text/html");
    expect(r.text).toContain("Request could not be completed");
    expect(r.text).toContain("Amount must be positive");
  });

  test("upload-limit reason reaches a browser page too", async () => {
    const r = await hit("/multer-big", { accept: HTML });
    expect(r.status).toBe(413);
    expect(r.text).toContain("Upload too large");
    expect(r.text).toContain("(image)");
  });
});

describe("M4 — JSON envelope is unchanged for API/fetch clients", () => {
  test("Accept: application/json keeps the exact status + message", async () => {
    const r = await hit("/boom", { accept: "application/json" });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text)).toEqual({ status: "failed", message: "db hiccup" });
  });

  test("no Accept header (fetch default */*) stays JSON — upload/AJAX contract", async () => {
    const r = await hit("/multer-big", { method: "GET" });
    expect(r.status).toBe(413);
    expect(JSON.parse(r.text).message).toMatch(/Upload too large/);
  });

  test("/api/* is ALWAYS JSON even when the client asks for HTML", async () => {
    const r = await hit("/api/v1/boom", { accept: HTML });
    expect(r.status).toBe(500);
    expect(r.type).toContain("application/json");
    expect(JSON.parse(r.text)).toEqual({ status: "failed", message: "api boom" });
  });

  test("XHR with Accept html still gets JSON", async () => {
    const r = await hit("/boom", { accept: HTML, xhr: true });
    expect(r.type).toContain("application/json");
    expect(JSON.parse(r.text).message).toBe("db hiccup");
  });

  test("JSON content-type wins over Accept html (AJAX POST contract)", async () => {
    const r = await hit("/echo", { method: "POST", accept: HTML, contentType: "application/json", body: "{bad json" });
    expect(r.status).toBe(400);
    expect(r.type).toContain("application/json");
    expect(JSON.parse(r.text).message).toMatch(/could not be read/i);
  });

  const mappings = [
    ["/validation", 400, /Amount is required/],
    ["/cast", 400, /Invalid _id: xyz/],
    ["/parse-fail", 400, /could not be read/i],
    ["/too-large", 413, /too large to process/i],
    ["/dup", 409, /Duplicate value for email/],
    ["/multer-big", 413, /Upload too large.*\(image\)/],
    ["/multer-field", 400, /Upload rejected.*\(evil\)/],
    ["/jwt", 401, /Invalid or expired token/],
    ["/cors", 403, /address the site does not accept/i],
    ["/bad-request", 400, /Amount must be positive/],
  ];
  test.each(mappings)("%s keeps status %i and message %p on the JSON channel", async (path, status, msgRe) => {
    const r = await hit(path, { accept: "application/json" });
    expect(r.status).toBe(status);
    const body = JSON.parse(r.text);
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(msgRe);
  });
});

describe("M4 — production masking still applies on both channels", () => {
  const OLD_ENV = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = OLD_ENV; });

  test("5xx JSON is masked in production; 4xx reason survives", async () => {
    process.env.NODE_ENV = "production";
    const boom = await hit("/boom", { accept: "application/json" });
    expect(JSON.parse(boom.text).message).toBe("Internal server error");
    const bad = await hit("/bad-request", { accept: "application/json" });
    expect(JSON.parse(bad.text).message).toBe("Amount must be positive");
  });

  test("5xx HTML never leaks the engine message in production either", async () => {
    process.env.NODE_ENV = "production";
    const r = await hit("/boom", { accept: HTML });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("db hiccup");
    expect(r.text).toContain("Something went wrong");
  });
});

// ── Part B: fees create — the head lookup must not escape as a raw 500 ──────

const mockGetAllFeeHeads = jest.fn();
jest.mock("../services/fees/feeHead.service", () => ({
  getAllFeeHeadsService: (...args) => mockGetAllFeeHeads(...args),
}));
const mockCreateFee = jest.fn();
jest.mock("../services/fees/fees.service", () => ({
  createFeeService: (...args) => mockCreateFee(...args),
  updateFeeService: jest.fn(),
  deleteFeeService: jest.fn(),
  bulkAssignFeesService: jest.fn(),
  bulkAssignPreviewService: jest.fn(),
  generateMonthlyFeesService: jest.fn(),
}));
jest.mock("../middlewares/authView", () => ({
  requireRole: () => (req, res, next) => next(),
}));
jest.mock("../models/Fees/fees.model", () => ({}));
jest.mock("../models/Students/students.model", () => ({ find: jest.fn() }));
jest.mock("../models/Parents/parents.model", () => ({ find: jest.fn() }));
jest.mock("../models/Academic/class.model", () => ({ find: jest.fn() }));
jest.mock("../utils/paginate", () => ({ paginate: jest.fn() }));

const feesRouter = require("../routes/views/fees.views");

function feesHandler(path, method) {
  const layer = feesRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const makeRes = () => ({
  render: jest.fn(),
  redirect: jest.fn(),
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
  locals: { schoolName: "Test School" },
});

describe("M4 — POST /fees/create head-lookup failure redirects with the reason", () => {
  beforeEach(() => jest.clearAllMocks());

  test("fee-head service throwing → ?error= redirect, create never runs", async () => {
    mockGetAllFeeHeads.mockRejectedValue(new Error("db hiccup"));
    const res = makeRes();
    await feesHandler("/fees/create", "post")(
      { user: { _id: "u1" }, body: { student: "s1", feeHead: "h1", amount: "500" } },
      res
    );
    expect(mockCreateFee).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith("/fees?error=" + encodeURIComponent("db hiccup"));
  });

  test("happy path still resolves the head name and redirects ?ok=1", async () => {
    mockGetAllFeeHeads.mockResolvedValue({ data: [{ _id: { toString: () => "h1" }, name: "Tuition" }] });
    mockCreateFee.mockImplementation(async (body, userId, cap) => {
      cap.status(200).json({ status: "success", message: "Created" });
    });
    const res = makeRes();
    await feesHandler("/fees/create", "post")(
      { user: { _id: "u1" }, body: { student: "s1", feeHead: "h1", amount: "500" } },
      res
    );
    expect(mockCreateFee).toHaveBeenCalledWith(
      expect.objectContaining({ student: "s1", feeHead: "h1", feeType: "Tuition", amount: 500 }),
      "u1",
      expect.anything()
    );
    expect(res.redirect).toHaveBeenCalledWith("/fees?ok=1");
  });

  test("create failure still redirects with the service message", async () => {
    mockGetAllFeeHeads.mockResolvedValue({ data: [] });
    mockCreateFee.mockImplementation(async (body, userId, cap) => {
      cap.status(400).json({ status: "failed", message: "Amount is required" });
    });
    const res = makeRes();
    await feesHandler("/fees/create", "post")(
      { user: { _id: "u1" }, body: { student: "s1", feeType: "tuition", amount: "0" } },
      res
    );
    expect(res.redirect).toHaveBeenCalledWith("/fees?error=" + encodeURIComponent("Amount is required"));
  });
});