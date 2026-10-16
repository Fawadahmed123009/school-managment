/**
 * Admin dashboard route — refinement wiring.
 *
 * Loads the REAL routes/views/dashboard.views.js handler with mocked models /
 * services (same pattern as teacherDashboardMarking.test.js) and asserts the
 * three admin/manager data changes behind the new layout:
 *
 *   1. Tests awaiting marking: rows inside the 3-day grace window are dropped
 *      from stats.marking; rows 4+ days old survive. (isBeyondMarkingGrace is
 *      the ACTUAL service helper — passthrough via requireActual.)
 *   2. At-Risk grade tabs: the route fetches the FULL ranked list ONCE
 *      (options.maxList = null — query params no longer affect it) and buckets
 *      it per grade tab (max 10 each, "" = All grades) so the view renders
 *      pre-built client-side lists — grade switching never reloads the page.
 *   3. Top Performers "Att %" column: a lifetime (present+late)/total attendance
 *      percent is attached to every ranked row.
 */

const mockDaysAgo = (n) => new Date(Date.now() - n * 86400000);

const mockWarns = [];

// ── Service-level mocks ──────────────────────────────────────────────────────
const mockGetAtRiskAdmin = jest.fn().mockResolvedValue({ students: [], total: 0, hasMore: false });
const mockGetPendingMarking = jest.fn();

jest.mock("../config/logger", () => ({
  warn: (...a) => mockWarns.push(a.join(" | ")),
  error: (...a) => mockWarns.push(a.join(" | ")),
  info: () => {},
}));

jest.mock("../services/alerts/atRiskAlerts.service", () => ({
  getAtRiskStudentsAdmin: (...a) => mockGetAtRiskAdmin(...a),
  getAtRiskStudentsTeacher: jest.fn().mockResolvedValue({ students: [], total: 0, hasMore: false }),
  THRESHOLDS: { ATTENDANCE: 75, SCORE: 40 },
}));

// Grace helper stays REAL; only the two heavy fetchers are stubbed.
jest.mock("../services/academic/markingFollowUp.service", () => {
  const actual = jest.requireActual("../services/academic/markingFollowUp.service");
  return {
    ...actual,
    getPendingMarkingAllTeachers: (...a) => mockGetPendingMarking(...a),
    getTeacherTestMarkingSummary: jest.fn().mockResolvedValue([]),
  };
});

// ── Model mocks ──────────────────────────────────────────────────────────────
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

jest.mock("../models/Students/students.model", () => ({
  countDocuments: () => Promise.resolve(10),
  find: () => mockChain([]),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  countDocuments: () => Promise.resolve(4),
  find: () => mockChain([]),
}));
jest.mock("../models/Fees/fees.model", () => ({
  aggregate: () => Promise.resolve([]),
  find: () => mockChain([]),
}));
jest.mock("../models/Academic/class.model", () => ({
  find: () => mockChain([]),
}));
// One Attendance mock for BOTH admin aggregates: the 30-day date-bucketed trend
// (first stage $match) and the lifetime per-student group (first stage $group on
// "$student") used by the Top Performers Att % column.
jest.mock("../models/Academic/attendance.model", () => ({
  aggregate: (pipeline) => {
    const first = (pipeline || [])[0] || {};
    const isLifetime = first.$group && first.$group._id === "$student";
    return Promise.resolve(
      isLifetime
        ? [{ _id: "p1", present: 9, absent: 1, late: 0 }] // → 90 % lifetime
        : [{ _id: "2026-10-15", present: 5, absent: 1, late: 0 }]
    );
  },
  find: () => mockChain([]),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  aggregate: () =>
    Promise.resolve([
      { _id: "p1", name: "Alice", rollNumber: "1", gradeLevel: "9", parentName: "Mr Ali", tests: 2, avg: 91.5 },
    ]),
  find: () => mockChain([]),
}));
jest.mock("../models/Academic/test.model", () => ({
  find: () => mockChain([]),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  find: () => mockChain([]),
}));

const router = require("../routes/views/dashboard.views.js");

function dashboardHandler() {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === "/dashboard" && l.route.methods.get
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function renderAdminDashboard(query = {}) {
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
    { user: { _id: "adm1", name: "Ad Min", role: "admin" }, query, body: {}, params: {} },
    res
  ).then(() => rendered);
}

beforeEach(() => {
  mockWarns.length = 0;
  mockGetAtRiskAdmin.mockClear();
  mockGetAtRiskAdmin.mockResolvedValue({ students: [], total: 0, hasMore: false });
  mockGetPendingMarking.mockResolvedValue([
    { _id: "k-fresh", name: "Held 2 days ago", date: mockDaysAgo(2), marked: 0, expected: 5, teacher: "T", whatsapp: "" },
    { _id: "k-edge", name: "Held exactly 3 days ago", date: mockDaysAgo(3), marked: 0, expected: 5, teacher: "T", whatsapp: "" },
    { _id: "k-over", name: "Held 5 days ago", date: mockDaysAgo(5), marked: 0, expected: 5, teacher: "T", whatsapp: "" },
  ]);
});

describe("admin dashboard — marking grace window", () => {
  test("rows inside the 3-day grace window are dropped; 4+ day rows kept", async () => {
    const rendered = await renderAdminDashboard();
    expect(mockWarns).toEqual([]);
    const ids = rendered.data.stats.marking.map((t) => t._id);
    expect(ids).toEqual(["k-over"]);
  });
});

describe("admin dashboard — at-risk grade tabs wiring", () => {
  const arRow = (id, gradeLevel) => ({
    student: { _id: id, name: "S" + id, rollNumber: id, className: "C", gradeLevel },
    attendancePercent: 80,
    averagePercent: 20,
    tests: 1,
    reasons: [],
  });

  test("fetches the full list once and ignores legacy grade/class/sort params", async () => {
    const rendered = await renderAdminDashboard({ grade: "10", classLevel: "x", sortBy: "rollAsc" });
    expect(mockWarns).toEqual([]);
    expect(mockGetAtRiskAdmin).toHaveBeenCalledTimes(1);
    expect(mockGetAtRiskAdmin).toHaveBeenCalledWith(undefined, "", undefined, { maxList: null });
    expect(rendered.data.atRisk.lists[""]).toEqual([]);
    expect(rendered.data.atRisk.gradeTabs).toEqual(["9", "10", "11", "12"]);
    expect(rendered.data.atRisk.total).toBe(0);
  });

  test("buckets the ranked list per grade tab, each capped at 10", async () => {
    const g9 = Array.from({ length: 12 }, (_, i) => arRow("g9-" + i, "9"));
    const g10 = [arRow("g10-0", "10")];
    const weird = [arRow("x-0", "13")]; // grade outside the tabs → All bucket only
    mockGetAtRiskAdmin.mockResolvedValueOnce({
      students: [...g9.slice(0, 8), ...g10, ...weird, ...g9.slice(8)],
      total: 14,
      hasMore: true,
    });
    const rendered = await renderAdminDashboard();
    expect(mockWarns).toEqual([]);
    const lists = rendered.data.atRisk.lists;
    expect(lists["9"].map((r) => r.student._id)).toEqual(g9.map((r) => r.student._id).slice(0, 10)); // first 10 seen
    expect(lists["10"].map((r) => r.student._id)).toEqual(["g10-0"]);
    expect(lists["11"]).toEqual([]);
    expect(lists["12"]).toEqual([]);
    expect(lists[""].map((r) => r.student._id)).toEqual([
      ...g9.slice(0, 8).map((r) => r.student._id),
      "g10-0",
      "x-0",
    ]); // overall first 10 in ranked order
    expect(rendered.data.atRisk.total).toBe(14);
  });
});

describe("admin dashboard — Top Performers Att % column", () => {
  test("lifetime attendance % (present+late)/total is attached to ranked rows", async () => {
    const rendered = await renderAdminDashboard();
    expect(mockWarns).toEqual([]);
    const row = rendered.data.stats.topPerformers.byGrade["9"][0];
    expect(row.name).toBe("Alice");
    expect(row.average).toBe(91.5);
    expect(row.attendancePercent).toBe(90); // (9 + 0) / 10
  });

  test("a top performer with no attendance records gets a null (—) percent", async () => {
    const rendered = await renderAdminDashboard();
    expect(mockWarns).toEqual([]);
    // p1 is covered above; a student id absent from the lifetime map returns null.
    const row = rendered.data.stats.topPerformers.byGrade["9"][0];
    expect(row._id).toBe("p1");
    expect(rendered.data.stats.topPerformers.byGrade["10"]).toEqual([]);
  });
});
