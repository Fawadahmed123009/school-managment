/**
 * Unified filter cascade on the admin/manager Test Analytics page
 * (/tests/analytics) — regression coverage for the gaps closed when the page
 * adopted the PDF Reports shared cascade (filter-cascade.ejs + prefix 'ax'):
 *
 *   1. getEnhancedTestAnalyticsService returns an UNFILTERED test snapshot
 *      (no server-side subject/class pre-narrowing) and populates session on
 *      the test options, so the client cascade narrowing has real data.
 *   2. The cascade's Student pick (studentId) filters the result set; the
 *      view-route-translated classLevelId still narrows by class.
 *   3. getTestTrendService honours the cascade-picked sessionId in BOTH modes
 *      (student: per-result test session; class: test query scope).
 *   4. report-filter-cascade.js exposes the factory and re-applies an
 *      #ax-filter-state restore selection (incl. pending grade/section) when
 *      the self-submitting GET form reloads — while the 'rs'/'an'/'sr'
 *      auto-inits no-op on a page that has none of those elements.
 *   5. Page wiring: analytics.ejs includes the shared partial with the 'ax'
 *      prefix and loads typeahead → cascade → init in order.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ═════════════════════════════════════════════════════════════════════════════
// 1–3. Service layer (models mocked at the data layer, real logic executes)
// ═════════════════════════════════════════════════════════════════════════════
const mockTestFind = jest.fn();
const mockTestFindById = jest.fn();
const mockTestResultFind = jest.fn();
// The testResult factory delegates here so single tests can swap the returned
// fixtures (plain mock-impl overrides on mockTestResultFind itself never reach
// the module factory's closure). Default: the standard rows, student-filtered.
const mockTestResultChain = jest.fn((q) => {
  let rows = MOCK_RESULTS_T1;
  if (q && q.student && q.student.$in) {
    const ids = q.student.$in.map(String);
    rows = rows.filter((r) => ids.includes(String(r.student._id)));
  }
  return mockChain(rows);
});
const mockStudentFind = jest.fn();
const mockClassLevelFind = jest.fn();
const mockSubjectFind = jest.fn();

// Chainable data-layer mock: records populate() args (also globally, so tests
// can assert the snapshot query's populates without reaching through the
// recording-only find mocks), resolves to `data`.
const mockChainLog = [];
function mockChain(data) {
  const c = { _populates: [] };
  ["select", "sort"].forEach((m) => { c[m] = () => c; });
  c.populate = (p) => { c._populates.push(p); mockChainLog.push(p); return c; };
  c.lean = () => Promise.resolve(data);
  c.then = (res, rej) => Promise.resolve(data).then(res, rej);
  return c;
}

const CLASS_A = "507f1f77bcf86cd799439033";
const CLASS_B = "507f1f77bcf86cd799439044";
const SUBJECT_ID = "507f1f77bcf86cd799439011";
const SESSION_1 = "507f1f77bcf86cd7994390aa";
const SESSION_2 = "507f1f77bcf86cd7994390bb";
const STUDENT_A = "507f1f77bcf86cd7994390cc";
const STUDENT_B = "507f1f77bcf86cd7994390dd";
const TEST_1 = "507f1f77bcf86cd7994390ee";

const MOCK_CLASSES = [
  { _id: CLASS_A, name: "9-A", gradeLevel: "9", section: "Boys" },
  { _id: CLASS_B, name: "9-B", gradeLevel: "9", section: "Girls" },
];
// Two tests from DIFFERENT sessions/subjects — a pre-narrowed snapshot query
// would drop one of them; the cascade must always receive the full catalogue.
const MOCK_SNAPSHOT_TESTS = [
  { _id: TEST_1, name: "Midterm Math", date: new Date("2026-01-10"), totalMarks: 100,
    subject: { _id: SUBJECT_ID, name: "Math" }, session: { _id: SESSION_1, name: "Fall 2025" },
    classLevels: [{ _id: CLASS_A, name: "9-A" }] },
  { _id: "t2", name: "Weekly Physics", date: new Date("2026-02-10"), totalMarks: 50,
    subject: { _id: "507f1f77bcf86cd799439012", name: "Physics" }, session: { _id: SESSION_2, name: "Spring 2026" },
    classLevels: [{ _id: CLASS_B, name: "9-B" }] },
];
const MOCK_TEST_1_DOC = {
  _id: TEST_1, name: "Midterm Math", date: new Date("2026-01-10"), totalMarks: 100,
  subject: { _id: SUBJECT_ID, name: "Math", displayName: "Math" },
  classLevels: [{ _id: CLASS_A, name: "9-A" }],
};
const MOCK_RESULTS_T1 = [
  { test: TEST_1, student: { _id: STUDENT_A }, score: 80, absent: false },
  { test: TEST_1, student: { _id: STUDENT_B }, score: 40, absent: false },
];
const MOCK_STUDENTS_BASIC = [{ _id: STUDENT_A }, { _id: STUDENT_B }];
const MOCK_STUDENTS_WITH_CLASS = [
  { _id: STUDENT_A, name: "Ali Khan", studentId: "AK", rollNumber: "7", classLevel: { _id: CLASS_A, name: "9-A" } },
  { _id: STUDENT_B, name: "Sara Malik", studentId: "SM", rollNumber: "12", classLevel: { _id: CLASS_A, name: "9-A" } },
];

jest.mock("../models/Academic/class.model", () => ({
  find: (q) => {
    mockClassLevelFind(q);
    let data = MOCK_CLASSES;
    if (q && q._id && q._id.$in) {
      const ids = q._id.$in.map(String);
      data = MOCK_CLASSES.filter((c) => ids.includes(String(c._id)));
    }
    return mockChain(data);
  },
}));
jest.mock("../models/Academic/subject.model", () => ({
  find: (...a) => { mockSubjectFind(...a); return mockChain([{ _id: SUBJECT_ID, name: "Math" }]); },
}));
jest.mock("../models/Academic/test.model", () => ({
  find: (...a) => { mockTestFind(...a); return mockChain(MOCK_SNAPSHOT_TESTS); },
  findById: (...a) => { mockTestFindById(...a); return mockChain(MOCK_TEST_1_DOC); },
  // Previous-test lookup for the comparison block — none in these fixtures.
  findOne: () => mockChain(null),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (q) => {
    mockTestResultFind(q);
    return mockTestResultChain(q);
  },
}));
jest.mock("../models/Students/students.model", () => ({
  find: (...a) => {
    mockStudentFind(...a);
    const q = a[0] || {};
    // Two-step student lookups: {_id} / {_id:$in} resolve by id, classLevel
    // matches filter by class.
    if (q._id && q._id.$in) return mockChain(MOCK_STUDENTS_WITH_CLASS.filter((s) => q._id.$in.some((id) => String(id) === String(s._id))));
    if (q._id) return mockChain(MOCK_STUDENTS_BASIC.filter((s) => String(s._id) === String(q._id)));
    if (q.classLevel) return mockChain(MOCK_STUDENTS_BASIC);
    return mockChain(MOCK_STUDENTS_BASIC);
  },
}));

const {
  getEnhancedTestAnalyticsService,
  getTestTrendService,
} = require("../services/academic/test.service");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const sent = (res) => res.json.mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  mockClassLevelFind.mockReset().mockImplementation(() => {});
});

describe("getEnhancedTestAnalyticsService — unfiltered cascade snapshot", () => {
  test("test-options query is NOT pre-narrowed by submitted subject/class", async () => {
    const res = mockRes();
    await getEnhancedTestAnalyticsService(
      { subjectId: SUBJECT_ID, classLevelId: CLASS_A },
      res
    );

    // The dropdown snapshot must be the FULL catalogue query…
    const findQueries = mockTestFind.mock.calls.map((c) => c[0]);
    expect(findQueries).toContainEqual({});
    // …and the response carries every test, not just the narrowed subset.
    expect(sent(res).tests).toHaveLength(MOCK_SNAPSHOT_TESTS.length);
  });

  test("test options carry the populated session (cascade data-session)", async () => {
    const res = mockRes();
    mockChainLog.length = 0;
    await getEnhancedTestAnalyticsService({}, res);

    // Snapshot query populates subject / classLevels / SESSION / week.
    expect(mockChainLog).toContain("session");
  });

  test("studentId (cascade Student picker) filters the result set", async () => {
    const res = mockRes();
    await getEnhancedTestAnalyticsService({ testId: TEST_1, studentId: STUDENT_A }, res);

    // Two-step path engaged with an exact-id match, not a name/roll regex.
    const studentQueries = mockStudentFind.mock.calls.map((c) => c[0]);
    expect(studentQueries).toContainEqual({ _id: STUDENT_A });
    // Only that pupil's row feeds the stats/table.
    expect(sent(res).resultCount).toBe(1);
    expect(sent(res).resultRows[0].name).toBe("Ali Khan");
  });

  test("view-route-translated classLevelId still narrows by class", async () => {
    const res = mockRes();
    await getEnhancedTestAnalyticsService({ testId: TEST_1, classLevelId: CLASS_A }, res);

    const studentQueries = mockStudentFind.mock.calls.map((c) => c[0]);
    expect(studentQueries).toContainEqual({ classLevel: { $in: [CLASS_A] } });
    expect(sent(res).resultCount).toBe(2);
  });
});

describe("getTestTrendService — cascade sessionId mapping", () => {
  test("class mode scopes the subject's test query to the session", async () => {
    const res = mockRes();
    await getTestTrendService({ mode: "class", subjectId: SUBJECT_ID, sessionId: SESSION_1 }, res);

    const testQueries = mockTestFind.mock.calls.map((c) => c[0]);
    expect(testQueries).toContainEqual({ subject: SUBJECT_ID, session: SESSION_1 });
  });

  test("student mode drops results whose test belongs to another session", async () => {
    const resultsOtherSession = [
      { test: { _id: TEST_1, name: "Midterm Math", totalMarks: 100, date: new Date("2026-01-10"), subject: { _id: SUBJECT_ID, name: "Math", displayName: "Math" }, session: { _id: SESSION_1, name: "Fall" } }, score: 80, absent: false },
      { test: { _id: "t9", name: "Other", totalMarks: 100, date: new Date("2026-03-10"), subject: { _id: SUBJECT_ID, name: "Math", displayName: "Math" }, session: { _id: SESSION_2, name: "Spring" } }, score: 60, absent: false },
    ];
    mockTestResultChain.mockImplementationOnce(() => mockChain(resultsOtherSession));
    const res = mockRes();
    await getTestTrendService({ mode: "student", studentId: STUDENT_A, sessionId: SESSION_1 }, res);
    const data = sent(res);
    expect(data.tableRows).toHaveLength(1);
    expect(data.tableRows[0].testName).toBe("Midterm Math");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Client factory reuse — 'ax' prefix + restore state (real files in a vm)
// ═════════════════════════════════════════════════════════════════════════════
const PUBLIC_JS = path.join(__dirname, "..", "public", "js");

// Minimal DOM stub (same conventions as studentTypeahead.test.js).
function makeEl(tag) {
  const el = {
    tagName: tag,
    className: "",
    textContent: "",
    value: "",
    style: {},
    dataset: {},
    disabled: false,
    attrs: {},
    children: [],
    _listeners: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, v) { this.attrs[name] = String(v); },
    appendChild(child) { this.children.push(child); return child; },
    querySelectorAll(sel) {
      const opt = /^option\[value="([^"]*)"\]$/.exec(sel);
      if (opt) return this.children.filter((c) => c.tagName === "option" && c.value === opt[1]);
      return this.children.filter((c) => c.tagName === sel);
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    fire(ev, arg) { (this._listeners[ev] || []).forEach((fn) => fn(arg || {})); },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return ""; },
    set(v) {
      if (v !== "") throw new Error("stub only supports clearing via innerHTML = ''");
      el.children = [];
      el.value = "";
    },
  });
  return el;
}

function makeSelect(id, optionDefs) {
  const sel = makeEl("select");
  sel.id = id;
  let current = "";
  Object.defineProperty(sel, "options", { get: () => sel.children });
  Object.defineProperty(sel, "value", {
    get: () => current,
    set(v) {
      const hit = sel.children.filter((o) => o.tagName === "option").some((o) => o.value === String(v));
      current = hit ? String(v) : "";
    },
  });
  (optionDefs || []).forEach((def) => {
    const opt = makeEl("option");
    opt.value = def.value;
    opt.textContent = def.label;
    Object.keys(def.attrs || {}).forEach((k) => opt.setAttribute(k, def.attrs[k]));
    sel.appendChild(opt);
  });
  current = "";
  return sel;
}

const AX_STUDENTS = [
  { _id: "stu-ali", name: "Ali Khan", rollNumber: "7", grade: "9", section: "Boys", classLevelId: CLASS_A },
  { _id: "stu-sara", name: "Sara Malik", rollNumber: "12", grade: "9", section: "Girls", classLevelId: CLASS_B },
];
const AX_TESTS = [
  { _id: TEST_1, name: "Midterm Math", subjectName: "Math", sessionId: SESSION_1, subjectId: SUBJECT_ID, classes: [CLASS_A] },
  { _id: "t2", name: "Weekly Physics", subjectName: "Physics", sessionId: SESSION_2, subjectId: "507f1f77bcf86cd799439012", classes: [CLASS_B] },
];

function buildAxPage(restoreState) {
  const els = {};
  // Only the 'ax' panel exists — the PDF page's rs/an/sr must be absent so the
  // shared file's auto-inits are proven to no-op harmlessly here.
  els["ax-session"] = makeSelect("ax-session", [{ value: "", label: "-- All sessions --" }].concat(
    [{ _id: SESSION_1, name: "Fall 2025" }, { _id: SESSION_2, name: "Spring 2026" }].map((s) => ({ value: String(s._id), label: s.name }))
  ));
  els["ax-grade"] = makeSelect("ax-grade", [{ value: "", label: "All grades" }]);
  els["ax-section"] = makeSelect("ax-section", [{ value: "", label: "All sections" }]);
  els["ax-student"] = makeSelect("ax-student", [{ value: "", label: "All students" }].concat(AX_STUDENTS.map((s) => ({
    value: String(s._id), label: s.name + " (" + s.rollNumber + ")",
    attrs: { "data-grade": s.grade, "data-section": s.section, "data-class": s.classLevelId, "data-name": s.name, "data-roll": s.rollNumber },
  }))));
  els["ax-subject"] = makeSelect("ax-subject", [{ value: "", label: "All subjects" }].concat([
    { value: SUBJECT_ID, label: "Math" },
    { value: "507f1f77bcf86cd799439012", label: "Physics" },
  ]));
  els["ax-test"] = makeSelect("ax-test", [{ value: "", label: "All tests" }].concat(AX_TESTS.map((t) => ({
    value: String(t._id), label: t.name,
    attrs: { "data-session": String(t.sessionId), "data-subject": String(t.subjectId), "data-classes": JSON.stringify(t.classes.map(String)) },
  }))));
  els["ax-test-count"] = makeEl("p");
  els["ax-student-search"] = makeEl("input");
  els["ax-student-results"] = makeEl("div");
  els["ax-student-hint"] = makeEl("p");
  els["report-class-scope"] = makeEl("script");
  els["report-class-scope"].textContent = JSON.stringify({
    [CLASS_A]: { grade: "9", section: "Boys" },
    [CLASS_B]: { grade: "9", section: "Girls" },
  });
  els["ax-filter-state"] = makeEl("script");
  els["ax-filter-state"].textContent = JSON.stringify(restoreState || {});

  const document = {
    getElementById: (id) => (Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null),
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const sandbox = { document, window: {}, alert: () => {}, console, Number, String, Object, Array, JSON, Math, RegExp, Date };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ["student-typeahead.js", "report-filter-cascade.js", "tests-analytics-cascade.js"].forEach((m) => {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_JS, m), "utf8"), sandbox, { filename: m });
  });
  return { els, sandbox };
}

describe("tests-analytics cascade — shared factory on the 'ax' prefix", () => {
  test("the shared file exposes the factory and its rs/an/sr auto-inits no-op", () => {
    const { sandbox } = buildAxPage({});
    expect(typeof sandbox.window.initReportFilterCascade).toBe("function");
    // No 'rs'/'an'/'sr' elements existed; the page still wired without throwing.
    expect(sandbox.window.__cascadeErrored).toBeUndefined();
  });

  test("fresh page (no restore) starts wide open", () => {
    const { els } = buildAxPage({});
    expect(els["ax-grade"].children.map((o) => o.value)).toEqual(["", "9"]);
    expect(els["ax-test"].children.map((o) => o.value)).toEqual(["", String(TEST_1), "t2"]);
  });

  test("restore state re-narrows every level after the GET reload", () => {
    const { els } = buildAxPage({
      sessionId: String(SESSION_1),
      grade: "9",
      section: "Boys",
      studentId: "stu-ali",
      subjectId: SUBJECT_ID,
      testId: String(TEST_1),
    });
    // Session/Student/Subject/Test were server-rendered → kept by the initial rebuild.
    expect(els["ax-session"].value).toBe(String(SESSION_1));
    expect(els["ax-student"].value).toBe("stu-ali");
    expect(els["ax-subject"].value).toBe(SUBJECT_ID);
    expect(els["ax-test"].value).toBe(String(TEST_1));
    // Grade/Section only materialise during the first rebuild (pending apply).
    expect(els["ax-grade"].value).toBe("9");
    expect(els["ax-section"].value).toBe("Boys");
    // And the narrowing is real: Fall-2025 covers CLASS_A only, so the student
    // pool is just Ali and the test list just Midterm Math.
    expect(els["ax-student"].children.map((o) => o.value)).toEqual(["", "stu-ali"]);
    expect(els["ax-test"].children.map((o) => o.value)).toEqual(["", String(TEST_1)]);
  });

  test("a stale restore pick (deleted option) degrades to the placeholder", () => {
    const { els } = buildAxPage({ testId: "no-longer-exists", grade: "42" });
    expect(els["ax-test"].value).toBe("");
    expect(els["ax-grade"].value).toBe("");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Page wiring
// ═════════════════════════════════════════════════════════════════════════════
describe("analytics page wiring", () => {
  const root = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

  test("analytics.ejs includes the shared partial with the 'ax' prefix in every mode", () => {
    const src = read("views/tests/analytics.ejs");
    const includes = src.match(/include\('\.\.\/reports\/partials\/filter-cascade', \{ idp: 'ax', namep: 'ax'/g) || [];
    // Single-test, Trend and Combined-subject modes all reuse the one cascade.
    expect(includes).toHaveLength(3);
  });

  test("typeahead loads before the cascade, cascade before the page init", () => {
    const src = read("views/tests/analytics.ejs");
    const typeahead = src.indexOf('<script src="/js/student-typeahead.js"></script>');
    const cascade = src.indexOf('<script src="/js/report-filter-cascade.js"></script>');
    const init = src.indexOf('<script src="/js/tests-analytics-cascade.js"></script>');
    expect(typeahead).toBeGreaterThan(-1);
    expect(cascade).toBeGreaterThan(typeahead);
    expect(init).toBeGreaterThan(cascade);
  });

  test("the retired checkbox partial and its script are gone", () => {
    expect(fs.existsSync(path.join(root, "views/tests/partials/class-filter.ejs"))).toBe(false);
    expect(fs.existsSync(path.join(root, "public/js/analytics-class-filter.js"))).toBe(false);
    expect(read("views/tests/analytics.ejs")).not.toContain("class-filter");
  });

  test("view route consumes the ax* submit names and translates grade/section before the services", () => {
    const src = read("routes/views/testAnalytics.views.js");
    expect(src).toContain("axTestId");
    expect(src).toContain("axGrade");
    expect(src).toContain("axSection");
    expect(src).toContain("axStudentId");
    expect(src).toContain("report-class-scope");
    expect(src).toContain("ax-filter-state");
  });
});
