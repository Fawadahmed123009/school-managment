/**
 * OCR marks scoping: the recommended match and the per-row student dropdown
 * must be limited to the students of the SELECTED TEST's class/section
 * (the test roster the teacher is assigned to) — never the whole school.
 *
 * Server: loads the REAL routes/views/marksOcr.views.js extract handler with
 * mocked dependencies and asserts:
 *   1. extraction refuses to run without a testId (no student query, no OCR call);
 *   2. the candidate pool is queried by roster ids (Student.find({_id:{$in:[…]}})),
 *      not school-wide;
 *   3. fuzzy recommendations can only resolve to roster students even when a
 *      perfect match exists outside the roster;
 *   4. the scoped pool is echoed back to the client (response.students).
 *
 * Client: loads the REAL public/js/marks-ocr-review.js in a vm DOM/fetch stub
 * (same pattern as c3XssReview.test.js) and asserts the extract request carries
 * the selected testId and the dropdown renders ONLY the scoped students.
 */

const path = require("path");
const vm = require("vm");

// ── Route-level mocks (must be declared before require of the router) ───────

const mockStudentFind = jest.fn();

jest.mock("../models/Students/students.model", () => ({
  find: (...args) => mockStudentFind(...args),
}));

const mockApiFetch = jest.fn();
jest.mock("../utils/apiClient", () => ({
  apiFetch: (...args) => mockApiFetch(...args),
  BASE_URL: "http://api.test",
}));

jest.mock("../middlewares/authView", () => ({
  requireRole: () => (req, res, next) => next(),
}));
jest.mock("../middlewares/csrf", () => ({
  verifyCsrf: (req, res, next) => next(),
}));
jest.mock("multer", () => () => ({
  single: () => (req, res, next) => next(),
}));
jest.mock("../services/fees/ocrScanArchive.service", () => ({
  archiveOcrScan: jest.fn().mockResolvedValue({ url: "https://r2/marks-scans/x.jpg" }),
  SCAN_KINDS: { fee: "fee-scans/", marks: "marks-scans/" },
}));
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    readFileSync: jest.fn(() => Buffer.from("image-bytes")),
    unlink: jest.fn((p, cb) => cb && cb()),
  };
});

const { matchStudent } = require("../utils/fuzzyMatch");

// Chainable lean() query stub returning the given docs. Real Mongoose query
// objects are chainable (select/populate/sort can be called in any order and
// populate more than once), so every link returns the same stub.
const leanQuery = (docs) => {
  const q = {
    select: () => q,
    populate: () => q,
    sort: () => q,
    lean: async () => docs,
  };
  return q;
};

/** Invoke the real extract handler from the views router. */
const getExtractHandler = () => {
  delete require.cache[require.resolve("../routes/views/marksOcr.views.js")];
  const router = require("../routes/views/marksOcr.views.js");
  const layer = router.stack.find(
    (l) => l.route && l.route.path === "/marks/ocr/extract" && l.route.methods.post
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const makeRes = () => {
  const res = { _statusCode: null, _body: null };
  res.status = jest.fn((c) => ((res._statusCode = c), res));
  res.json = jest.fn((b) => ((res._body = b), res));
  return res;
};

const EXTRACT_ROW = { name: "Alina Smith", score: 42, confidence: "high" };

const ROSTER_STUDENTS = [
  { _id: "in-scope-1", name: "Alina Smyth", rollNumber: "12", classLevel: { _id: "c1", name: "Grade 9-A" } },
];
// A near-perfect match that lives OUTSIDE the selected test's section.
const OUT_OF_SCOPE_STUDENT = {
  _id: "out-scope-1",
  name: "Alina Smith",
  rollNumber: "77",
  classLevel: { _id: "c2", name: "Grade 9-B" },
};

let handler;
let req;
let res;

beforeEach(() => {
  jest.clearAllMocks();
  handler = getExtractHandler();
  req = {
    file: { path: "uploads/img", originalname: "scan.jpg", mimetype: "image/jpeg" },
    body: { testId: "test-1" },
    token: "tok",
  };
  res = makeRes();
  mockApiFetch.mockResolvedValue({
    status: "success",
    data: { test: { _id: "test-1" }, roster: ROSTER_STUDENTS.map((s) => ({ student: s._id, name: s.name })) },
  });
  mockStudentFind.mockReturnValue(leanQuery(ROSTER_STUDENTS));
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => ({ status: "success", data: [EXTRACT_ROW] }),
  });
});

describe("marks OCR extract: candidate scoping (server)", () => {
  test("refuses to extract without a selected test — no student lookup, no OCR call", async () => {
    req.body = {};
    await handler(req, res);

    expect(res._body.status).toBe("failed");
    expect(res._body.message).toMatch(/select a test/i);
    expect(mockStudentFind).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("candidate pool is queried by roster ids only, never school-wide", async () => {
    await handler(req, res);

    expect(mockApiFetch).toHaveBeenCalledWith("/tests/test-1/roster", "tok");
    expect(mockStudentFind).toHaveBeenCalledTimes(1);
    const filter = mockStudentFind.mock.calls[0][0];
    expect(filter).toEqual({ _id: { $in: ["in-scope-1"] } });
  });

  test("roster load failure aborts extraction before the OCR call", async () => {
    mockApiFetch.mockResolvedValue({ status: "failed", message: "not assigned" });
    await handler(req, res);

    expect(res._body.status).toBe("failed");
    expect(res._body.message).toBe("not assigned");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("recommended match can only resolve to a roster student", async () => {
    await handler(req, res);

    expect(res._body.status).toBe("success");
    const row = res._body.data[0];
    // "Alina Smith" is a perfect match for out-scope-1, but that student is
    // not in the selected test's section — recommendation must stay in scope.
    expect(row.studentId).toBe("in-scope-1");
    expect(row.studentId).not.toBe("out-scope-1");
  });

  test("echoes the scoped student pool back for the dropdowns", async () => {
    await handler(req, res);

    expect(Array.isArray(res._body.students)).toBe(true);
    expect(res._body.students.map((s) => s._id)).toEqual(["in-scope-1"]);
  });

  test("utility-level sanity: school-wide pool WOULD have matched out of scope", async () => {
    // Proves the scoping test above is meaningful: matching against all
    // students picks the out-of-section clone.
    const match = matchStudent(EXTRACT_ROW.name, [...ROSTER_STUDENTS, OUT_OF_SCOPE_STUDENT]);
    expect(match.studentId).toBe("out-scope-1");
  });
});

// ── Client: marks-ocr-review.js vm harness ──────────────────────────────────

// The router under test uses fs for the uploaded image; read real source
// files through the unmocked module.
const realFs = jest.requireActual("fs");

const PUBLIC_JS = path.join(__dirname, "..", "public", "js");

function loadEscapeHtml() {
  const src = realFs.readFileSync(path.join(PUBLIC_JS, "escape-html.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.escapeHtml;
}
const escapeHtml = loadEscapeHtml();

function buildHarness({ studentsJson, extractResponse, selectedTestId }) {
  const innerHtmlWrites = [];
  const fetchCalls = [];
  const alerts = [];
  const elements = new Map();
  const listeners = {};

  function el(id) {
    if (elements.has(id)) return elements.get(id);
    const node = {
      id,
      _innerHTML: "",
      textContent: id === "marks-ocr-students" ? studentsJson : "",
      value: "",
      src: "",
      files: [{ name: "scan.jpg" }],
      disabled: false,
      style: {},
      dataset: {},
      classList: { add: () => {}, remove: () => {} },
      querySelector: () => node,
      querySelectorAll: () => [],
      appendChild: () => {},
      remove: () => {},
      addEventListener: (ev, fn) => {
        listeners[id] = listeners[id] || {};
        listeners[id][ev] = fn;
      },
      removeEventListener: () => {},
      setAttribute: () => {},
      click: () => {},
    };
    Object.defineProperty(node, "innerHTML", {
      get: () => node._innerHTML,
      set(v) {
        node._innerHTML = v;
        innerHtmlWrites.push({ id, html: v });
      },
    });
    elements.set(id, node);
    return node;
  }

  class CapturingFormData {
    constructor() {
      this.entries = [];
    }
    append(k, v) {
      this.entries.push([k, v]);
    }
  }

  const sandbox = {
    window: {
      escapeHtml,
      CSRF_TOKEN: "t",
      location: { href: "" },
      selectedTestId,
    },
    document: {
      getElementById: (id) => el(id),
      querySelectorAll: () => [],
      querySelector: () => el("__q"),
      createElement: () => el("__c" + elements.size),
    },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, formData: opts && opts.body });
      return { json: async () => extractResponse, ok: true, blob: async () => ({}) };
    },
    alert: (msg) => alerts.push(msg),
    console,
    URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    Number,
    String,
    JSON,
    Math,
    Date,
    Promise,
    encodeURIComponent,
    setTimeout,
    FormData: CapturingFormData,
    File: class {
      constructor(parts, name) {
        this.parts = parts;
        this.name = name;
      }
    },
    Event: class {
      constructor(t) {
        this.type = t;
      }
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(realFs.readFileSync(path.join(PUBLIC_JS, "marks-ocr-review.js"), "utf8"), sandbox, {
    filename: "marks-ocr-review.js",
  });

  return {
    innerHtmlWrites,
    fetchCalls,
    alerts,
    async fireChange(id) {
      await listeners[id].change();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe("marks OCR review (client): sends testId + renders scoped dropdown", () => {
  const schoolWide = [
    { _id: "out-scope-1", name: "Alina Smith", rollNumber: "77", classLevel: { name: "Grade 9-B" } },
  ];
  const scoped = [
    { _id: "in-scope-1", name: "Alina Smyth", rollNumber: "12", classLevel: { name: "Grade 9-A" } },
  ];

  test("extract request carries the selected testId", async () => {
    const h = buildHarness({
      studentsJson: JSON.stringify(schoolWide),
      selectedTestId: "test-1",
      extractResponse: { status: "success", archivedUrl: "", data: [EXTRACT_ROW], students: scoped },
    });
    await h.fireChange("photo-input");

    const extract = h.fetchCalls.find((c) => String(c.url).includes("/marks/ocr/extract"));
    expect(extract).toBeDefined();
    const entries = extract.formData.entries;
    expect(entries).toEqual(expect.arrayContaining([["testId", "test-1"]]));
  });

  test("dropdown lists ONLY the scoped students returned by the server", async () => {
    const h = buildHarness({
      studentsJson: JSON.stringify(schoolWide),
      selectedTestId: "test-1",
      extractResponse: {
        status: "success",
        archivedUrl: "",
        data: [{ ...EXTRACT_ROW, studentId: "in-scope-1" }],
        students: scoped,
      },
    });
    await h.fireChange("photo-input");

    const rowWrites = h.innerHtmlWrites.filter((w) => w.id === "rows-body");
    expect(rowWrites.length).toBeGreaterThan(0);
    const html = rowWrites[rowWrites.length - 1].html;
    expect(html).toContain("Alina Smyth"); // scoped student — present
    // The out-of-section student must not appear as a dropdown option (the
    // bare "Alina Smith" text is just the OCR-read name placeholder).
    expect(html).not.toContain("out-scope-1");
    expect(html).not.toContain("Roll #77");
    expect(html).toContain('value="in-scope-1"');
    expect(html).toContain("selected"); // recommended match pre-selected
  });

  test("aborts before fetching when no test is selected", async () => {
    const h = buildHarness({
      studentsJson: JSON.stringify(schoolWide),
      selectedTestId: "",
      extractResponse: { status: "success", data: [], students: [] },
    });
    await h.fireChange("photo-input");

    expect(h.fetchCalls).toHaveLength(0);
    expect(h.alerts.join(" ")).toMatch(/select a test/i);
  });
});
