/**
 * Tests for C3: XSS hardening of the OCR / import review UIs.
 *
 * The three review pages (fees OCR, marks OCR, student import) build table
 * rows as HTML strings and assign them to innerHTML. The interpolated data is
 * attacker-reachable: parsed spreadsheet cells, Gemini-echoed extract errors,
 * and stored student/class names.
 *
 * These tests load the REAL public/js modules inside a Node vm with a minimal
 * DOM/fetch stub, feed them hostile payloads, and assert the HTML they write
 * into innerHTML contains no raw markup. Plus unit checks on the shared
 * escaper (public/js/escape-html.js) and template wiring.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PUBLIC_JS = path.join(__dirname, "..", "public", "js");
const VIEWS = path.join(__dirname, "..", "views");

const HOSTILE_NAME = '<img src=x onerror="alert(1)"><script>alert(2)<\/script>';
const HOSTILE_QUOTE = '"><svg onload=alert(3)>';

// ── Shared escaper, loaded the same way a browser would ────────────────────
function loadEscapeHtml() {
  const src = fs.readFileSync(path.join(PUBLIC_JS, "escape-html.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.window.escapeHtml;
}

const escapeHtml = loadEscapeHtml();

describe("escapeHtml (public/js/escape-html.js)", () => {
  test("neutralises script tags", () => {
    const out = escapeHtml('<script>alert("xss")</script>');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("neutralises quote-based attribute breakouts", () => {
    // e.g. <option value="${...}"> — a raw " would close the attribute and
    // let onerror=... start a new one.
    const out = escapeHtml('a" onerror="alert(1)');
    expect(out).not.toContain('"');
    expect(out).toContain("&quot;");
  });

  test("neutralises single quotes, backticks, and leaves no bare < or >", () => {
    expect(escapeHtml("it's")).toContain("&#39;");
    expect(escapeHtml("`tpl`")).toContain("&#96;");
    expect(escapeHtml('<img src=x onerror="alert(1)">')).not.toMatch(/[<>]/);
  });

  test("escapes ampersands first (no double-encoding of its own output)", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  test("null / undefined render as empty string; numbers as their string form", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });

  test("safe strings are unchanged", () => {
    expect(escapeHtml("Ali Khan — Roll #7")).toBe("Ali Khan — Roll #7");
  });
});

// ── Minimal DOM + fetch stub, enough to run the review UI modules ──────────

function buildHarness({ htmlModules, jsonElements, routes }) {
  const innerHtmlWrites = [];
  const elements = new Map();
  const listeners = {};

  function el(id) {
    if (elements.has(id)) return elements.get(id);
    const node = {
      id,
      _innerHTML: "",
      textContent: jsonElements[id] || "",
      value: "",
      src: "",
      // A stubbed file so the change handlers don't early-return.
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
      get() {
        return node._innerHTML;
      },
      set(v) {
        node._innerHTML = v;
        innerHtmlWrites.push({ id, html: v });
      },
    });
    elements.set(id, node);
    return node;
  }

  const document = {
    getElementById: (id) => el(id),
    querySelectorAll: () => [],
    querySelector: () => el("__panel"),
    createElement: () => el("__created" + elements.size),
  };

  const sandbox = {
    window: {
      escapeHtml,
      CSRF_TOKEN: "test",
      location: { href: "" },
      selectedTestId: "test1",
    },
    document,
    fetch: async (url) => {
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      const body = key ? routes[key] : { status: "error", message: "not stubbed" };
      return { json: async () => body, ok: true, blob: async () => ({}) };
    },
    alert: () => {},
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
    FormData: class {
      constructor() {
        this.entries = [];
      }
      append(k, v) {
        this.entries.push([k, v]);
      }
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  htmlModules.forEach((m) =>
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_JS, m), "utf8"), sandbox, {
      filename: m,
    })
  );

  return {
    sandbox,
    el,
    innerHtmlWrites,
    listeners,
    fireChange: async (id) => {
      expect(listeners[id] && listeners[id].change).toBeDefined();
      await listeners[id].change();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    fireClick: async (id) => {
      expect(listeners[id] && listeners[id].click).toBeDefined();
      await listeners[id].click();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

function expectNoRawMarkup(writes, payloads) {
  const all = writes.map((w) => w.html).join("\n");
  // Bare opening tags injected from a payload (a "<" that starts a tag name)
  // must not appear. Legit static template tags are re-checked below.
  expect(all).not.toMatch(/<(script|img|svg|iframe)\b/i);
  // Event handler with a RAW quote after "=" means the payload is live markup.
  // Escaped payload text reads onerror=&quot; — excluded by the lookbehind.
  expect(all).not.toMatch(/(?<=[\s>])on(error|load|mouseover|focus)\s*=\s*["']/i);
  // The raw payloads themselves must never appear.
  payloads.forEach((p) => expect(all).not.toContain(p));
  // And escape sequences must be present — proof the data rendered as text,
  // not markup.
  expect(all).toMatch(/&lt;|&quot;/);
}

// ── fees OCR review ────────────────────────────────────────────────────────

describe("C3: fees OCR review (ocr-review.js)", () => {
  const routes = {
    "/fees/ocr/extract": {
      status: "success",
      archivedUrl: "",
      data: [
        { name: HOSTILE_NAME, amount: 500, confidence: "high", studentId: "s1" },
        { name: HOSTILE_QUOTE, amount: null, confidence: "low", studentId: "" },
      ],
    },
  };
  const studentsJson = JSON.stringify([
    { _id: "s1", name: HOSTILE_NAME, rollNumber: HOSTILE_QUOTE, classLevel: { name: "Grade <b>5</b>" } },
  ]);

  test("rendered rows contain no raw markup from OCR name/amount/confidence", async () => {
    const h = buildHarness({
      htmlModules: ["ocr-review.js"],
      jsonElements: { "ocr-students": studentsJson },
      routes,
    });
    await h.fireChange("photo-input");
    const rowWrites = h.innerHtmlWrites.filter((w) => w.id === "rows-body");
    expect(rowWrites.length).toBeGreaterThan(0);
    expectNoRawMarkup(rowWrites, [HOSTILE_NAME, HOSTILE_QUOTE]);
    // The escaped form IS present — proof the data flowed through the escaper.
    expect(rowWrites.map((w) => w.html).join()).toContain("&lt;script&gt;");
  });

  test("extract error message is escaped, not injected", async () => {
    const h = buildHarness({
      htmlModules: ["ocr-review.js"],
      jsonElements: { "ocr-students": studentsJson },
      routes: {
        "/fees/ocr/extract": {
          status: "error",
          message: `Gemini failed on ${HOSTILE_NAME}`,
        },
      },
    });
    await h.fireChange("photo-input");
    expectNoRawMarkup(
      h.innerHtmlWrites.filter((w) => w.id === "rows-body"),
      [HOSTILE_NAME]
    );
  });

  test("needs-review candidate strings are escaped", async () => {
    const h = buildHarness({
      htmlModules: ["ocr-review.js"],
      jsonElements: { "ocr-students": studentsJson },
      routes: {
        "/fees/ocr/extract": routes["/fees/ocr/extract"],
        "/fees/ocr/confirm": {
          status: "success",
          data: {
            summary: { created: 0, updated: 0, needsReview: 1 },
            needsReview: [
              {
                studentName: HOSTILE_NAME,
                amount: 100,
                candidates: [
                  { _id: HOSTILE_QUOTE, feeType: HOSTILE_NAME, amount: 1, notes: HOSTILE_NAME, createdAt: null },
                ],
              },
            ],
          },
        },
      },
    });
    await h.fireChange("photo-input");
    // Provide a "ready" row (select + amount) through the module's own query
    // path so the save handler proceeds to /fees/ocr/confirm → showReviewSection.
    const writesBefore = h.innerHtmlWrites.length;
    const sel = { value: "s1", dataset: {} };
    const amt = { value: "500" };
    h.sandbox.document.querySelectorAll = (q) =>
      q === ".student-select" ? [sel] : q === ".amount-input" ? [amt] : [];
    await h.fireClick("save-btn");
    const reviewWrites = h.innerHtmlWrites.slice(writesBefore);
    expect(reviewWrites.length).toBeGreaterThan(0);
    expectNoRawMarkup(reviewWrites, [HOSTILE_NAME, HOSTILE_QUOTE]);
  });
});

// ── marks OCR review ───────────────────────────────────────────────────────

describe("C3: marks OCR review (marks-ocr-review.js)", () => {
  const studentsJson = JSON.stringify([
    { _id: "s1", name: HOSTILE_NAME, rollNumber: '"><svg onload=alert(3)>', classLevel: { name: "Grade 5" } },
  ]);

  test("rendered rows contain no raw markup from OCR name/score/roll", async () => {
    const h = buildHarness({
      htmlModules: ["marks-ocr-review.js"],
      jsonElements: { "marks-ocr-students": studentsJson },
      routes: {
        "/marks/ocr/extract": {
          status: "success",
          archivedUrl: "",
          data: [
            { name: HOSTILE_NAME, score: '"><svg onload=alert(3)>', confidence: "high", studentId: "s1" },
          ],
        },
      },
    });
    // open picker (sets testId) then change file
    await h.fireClick("pick-photo-btn");
    await h.fireChange("photo-input");
    const rowWrites = h.innerHtmlWrites.filter((w) => w.id === "rows-body");
    expect(rowWrites.length).toBeGreaterThan(0);
    expectNoRawMarkup(rowWrites, [HOSTILE_NAME, '<svg onload=alert(3)>']);
    expect(rowWrites.map((w) => w.html).join()).toContain("&lt;script&gt;");
  });

  test("extract error message is escaped", async () => {
    const h = buildHarness({
      htmlModules: ["marks-ocr-review.js"],
      jsonElements: { "marks-ocr-students": studentsJson },
      routes: {
        "/marks/ocr/extract": { status: "error", message: `bad: ${HOSTILE_NAME}` },
      },
    });
    await h.fireClick("pick-photo-btn");
    await h.fireChange("photo-input");
    expectNoRawMarkup(
      h.innerHtmlWrites.filter((w) => w.id === "rows-body"),
      [HOSTILE_NAME]
    );
  });
});

// ── student import review ──────────────────────────────────────────────────

describe("C3: student import review (student-import.js)", () => {
  const classesJson = JSON.stringify([{ _id: "c1", name: HOSTILE_NAME }]);
  const parseRoutes = {
    "/students/import/parse": {
      status: "success",
      data: [
        {
          name: HOSTILE_NAME,
          admissionNumber: HOSTILE_QUOTE,
          rollNumber: HOSTILE_QUOTE,
          rawClassText: HOSTILE_NAME,
          matchedClassId: "",
        },
      ],
    },
  };

  test("parsed spreadsheet cells never reach innerHTML raw", async () => {
    const h = buildHarness({
      htmlModules: ["student-import.js"],
      jsonElements: { "import-classes": classesJson },
      routes: parseRoutes,
    });
    await h.fireChange("file-input");
    const rowWrites = h.innerHtmlWrites.filter((w) => w.id === "rows-body");
    expect(rowWrites.length).toBeGreaterThan(0);
    expectNoRawMarkup(rowWrites, [HOSTILE_NAME, HOSTILE_QUOTE]);
    expect(rowWrites.map((w) => w.html).join()).toContain("&lt;script&gt;");
  });

  test("import results table escapes name/email/tempPassword", async () => {
    const h = buildHarness({
      htmlModules: ["student-import.js"],
      jsonElements: { "import-classes": classesJson },
      routes: {
        ...parseRoutes,
        "/students/import/confirm": {
          status: "success",
          data: {
            created: [
              { name: HOSTILE_NAME, email: HOSTILE_QUOTE, tempPassword: HOSTILE_NAME },
            ],
            skipped: [],
          },
        },
      },
    });
    await h.fireChange("file-input");
    // Give the module a ready row: one select with class, one roll input.
    const selEl = { value: "c1", dataset: {}, style: {} };
    const rollEl = { value: "r1", dataset: {}, style: {} };
    const trEl = { dataset: { row: "0" }, querySelector: (s) => (s === ".class-select" ? selEl : rollEl) };
    h.sandbox.document.querySelectorAll = (q) => {
      if (q === "#rows-body tr") return [trEl];
      if (q === ".class-select") return [selEl];
      if (q === ".roll-input") return [rollEl];
      return [];
    };
    const writesBefore = h.innerHtmlWrites.length;
    await h.fireClick("save-btn");
    const resultWrites = h.innerHtmlWrites.slice(writesBefore);
    expectNoRawMarkup(resultWrites, [HOSTILE_NAME, HOSTILE_QUOTE]);
  });
});

// ── Template wiring ────────────────────────────────────────────────────────

describe("C3 wiring: pages load the escaper before the UI modules", () => {
  test.each([
    ["fees/ocr.ejs", "ocr-review.js"],
    ["marks/ocr.ejs", "marks-ocr-review.js"],
    ["students/import.ejs", "student-import.js"],
  ])("%s includes /js/escape-html.js before /js/%s", (tpl, uiScript) => {
    const src = fs.readFileSync(path.join(VIEWS, tpl), "utf8");
    const escIdx = src.indexOf('<script src="/js/escape-html.js"></script>');
    const uiIdx = src.indexOf(`<script src="/js/${uiScript}"></script>`);
    expect(escIdx).toBeGreaterThan(-1);
    expect(uiIdx).toBeGreaterThan(-1);
    expect(escIdx).toBeLessThan(uiIdx);
  });
});
