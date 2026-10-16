/**
 * Teacher dashboard "overdue, not fully marked" panel — admission-date scoping.
 *
 * The teacher panel measures each past-dated test against the pupils of its
 * classes. A student enrolled AFTER a test was held never sat it, so they must
 * not be counted as outstanding marking for that test — otherwise joining a new
 * child silently pins every older test to "not fully marked" on the teacher's
 * own dashboard, even though their mark-entry roster correctly omits the child.
 *
 * Loads the REAL routes/views/dashboard.views.js handler with mocked models so
 * the actual expected/marked maths executes. The whole handler sits in a
 * try/catch that swallows errors, so any logged warning is surfaced as a test
 * failure instead of rendering silently-empty stats.
 *
 *   • an old test whose eligible pupils are all marked disappears from the list;
 *   • an old test that really is short one score still appears, and its
 *     `expected` counts only the pupils admitted by that test's day;
 *   • a test held AFTER a new child joined still expects that child.
 *
 * Fixture identifiers are `mock`-prefixed so the hoisted jest.mock() factories
 * may reference them.
 */

const mockDaysAgo = (n) => new Date(Date.now() - n * 86400000);

// ── Data fixtures ────────────────────────────────────────────────────────────
const mockAssignments = [
  {
    teacher: "t1",
    subject: { _id: "s1", name: "Math" },
    classLevel: { _id: "c1", name: "Class 1", gradeLevel: "1", group: null, section: null },
  },
];

const mockStudents = [
  { _id: "sOld", classLevel: "c1", dateAdmitted: mockDaysAgo(60) },
  // Joined the class 5 days ago — after the two 10-day-old tests were held, but
  // BEFORE the 4-day-old test, so that newer test still expects this child.
  { _id: "sNew", classLevel: "c1", dateAdmitted: mockDaysAgo(5) },
];

const mockTests = [
  {
    _id: "k-old-done",
    name: "Old Test (complete for its roster)",
    subject: { _id: "s1", name: "Math" },
    classLevels: [{ _id: "c1", name: "Class 1" }],
    date: mockDaysAgo(10),
  },
  {
    _id: "k-old-pending",
    name: "Old Test (one score missing)",
    subject: { _id: "s1", name: "Math" },
    classLevels: [{ _id: "c1", name: "Class 1" }],
    date: mockDaysAgo(10),
  },
  {
    // 4 days ago — beyond the 3-day marking grace window AND after sNew joined
    // (5 days ago), so it still lists as overdue and expects the new child.
    _id: "k-recent",
    name: "Test held after the new enrolment",
    subject: { _id: "s1", name: "Math" },
    classLevels: [{ _id: "c1", name: "Class 1" }],
    date: mockDaysAgo(4),
  },
  {
    // 2 days ago — INSIDE the 3-day grace window. Unmarked, but the teacher is
    // still within their marking window, so (matching the admin panel) it must
    // NOT surface on the backlog.
    _id: "k-in-grace",
    name: "Test still inside the marking grace window",
    subject: { _id: "s1", name: "Math" },
    classLevels: [{ _id: "c1", name: "Class 1" }],
    date: mockDaysAgo(2),
  },
];

// k-old-done: its only eligible pupil (sOld) is marked. k-old-pending: not marked.
const mockResults = [{ test: "k-old-done", student: "sOld" }];

// Chainable + awaitable query stub (select / populate / sort / lean / then).
function mockChain(docs) {
  const chain = {
    select: () => chain,
    populate: () => chain,
    sort: () => chain,
    lean: () => Promise.resolve(docs),
    then: (resolve, reject) => Promise.resolve(docs).then(resolve, reject),
  };
  return chain;
}

const mockWarns = [];

// ── Model / service mocks ────────────────────────────────────────────────────
jest.mock("../config/logger", () => ({
  warn: (...a) => mockWarns.push(a.join(" | ")),
  error: (...a) => mockWarns.push(a.join(" | ")),
  info: () => {},
}));

jest.mock("../models/Academic/assignment.model", () => ({
  find: () => mockChain(mockAssignments),
}));
jest.mock("../models/Academic/test.model", () => ({
  find: () => mockChain(mockTests),
}));
jest.mock("../models/Students/students.model", () => ({
  find: (q) => {
    let out = mockStudents;
    if (q && q.classLevel && q.classLevel.$in) {
      const ids = q.classLevel.$in.map(String);
      out = out.filter((s) => ids.includes(String(s.classLevel)));
    }
    return mockChain(out);
  },
  countDocuments: () => Promise.resolve(mockStudents.length),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (q) => {
    let out = mockResults;
    if (q && q.test && q.test.$in) {
      const ids = q.test.$in.map(String);
      out = out.filter((r) => ids.includes(String(r.test)));
    }
    if (q && q.student && q.student.$in) {
      const ids = q.student.$in.map(String);
      out = out.filter((r) => ids.includes(String(r.student)));
    }
    return mockChain(out);
  },
  // The redesigned teacher branch also runs a TestResult.aggregate for the
  // Top Performers panel. Resolve to an empty roster so the handler executes
  // without warning (the panel-under-test here is the marking backlog).
  aggregate: () => Promise.resolve([]),
}));
jest.mock("../models/Academic/attendance.model", () => ({
  aggregate: () => Promise.resolve([]),
  find: () => mockChain([]),
}));
jest.mock("../models/Fees/fees.model", () => ({
  find: () => mockChain([]),
  aggregate: () => Promise.resolve([]),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  countDocuments: () => Promise.resolve(1),
}));
jest.mock("../models/Academic/class.model", () => ({
  find: () => mockChain([]),
}));
// The panel under test is teacher-scoped; these admin aggregations only need to
// resolve so the route's requires don't blow up.
jest.mock("../services/alerts/atRiskAlerts.service", () => ({
  getAtRiskStudentsAdmin: jest.fn(),
  getAtRiskStudentsTeacher: jest.fn().mockResolvedValue({ students: [] }),
  THRESHOLDS: {},
}));
jest.mock("../services/academic/markingFollowUp.service", () => {
  // The dashboard imports the real grace predicate alongside the two heavy
  // admin-only fetchers. Keep the genuine 3-day logic (it is a pure function)
  // so the grace-window assertion tests the real behaviour, and stub only the
  // DB-backed admin functions the teacher branch never calls.
  const real = jest.requireActual("../services/academic/markingFollowUp.service");
  return {
    getPendingMarkingAllTeachers: jest.fn().mockResolvedValue([]),
    getTeacherTestMarkingSummary: jest.fn().mockResolvedValue([]),
    isBeyondMarkingGrace: real.isBeyondMarkingGrace,
  };
});

const router = require("../routes/views/dashboard.views.js");

/** The real GET /dashboard handler from the router stack. */
function dashboardHandler() {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === "/dashboard" && l.route.methods.get
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function renderTeacherDashboard() {
  const rendered = {};
  const res = {
    locals: { schoolName: "Test School" },
    render: (view, data) => {
      rendered.view = view;
      rendered.data = data;
    },
    redirect: () => {},
  };
  return dashboardHandler()(
    { user: { _id: "t1", role: "teacher" }, query: {}, body: {}, params: {} },
    res
  ).then(() => rendered);
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("teacher dashboard — marking follows the test's admission-date roster", () => {
  let rows;

  beforeEach(async () => {
    mockWarns.length = 0;
    const rendered = await renderTeacherDashboard();
    expect(rendered.view).toBe("dashboard");
    // The handler swallows exceptions into logger.warn — never test blind.
    expect(mockWarns).toEqual([]);
    rows = rendered.data.stats.teacher.overdueUnmarked;
  });

  test("an old test whose eligible pupils are all marked is not listed", () => {
    expect(rows.map((r) => r._id)).not.toContain("k-old-done");
  });

  test("an old test that is genuinely short a score still shows, counted over its eligible pupils only", () => {
    const pending = rows.find((r) => r._id === "k-old-pending");
    expect(pending).toBeDefined();
    // Two pupils sit in Class 1 today, but only sOld was admitted by the test day.
    expect(pending.expected).toBe(1);
    expect(pending.marked).toBe(0);
  });

  test("a test held after a new enrolment still expects that child", () => {
    const recent = rows.find((r) => r._id === "k-recent");
    expect(recent).toBeDefined();
    expect(recent.expected).toBe(2);
  });

  test("a test still inside the 3-day marking grace window is NOT listed (matches admin)", () => {
    // k-in-grace is 2 days old and unmarked, but the teacher's grace window
    // keeps it off the backlog — the same filter the admin panel applies.
    expect(rows.map((r) => r._id)).not.toContain("k-in-grace");
  });
});
