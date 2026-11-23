/**
 * Teacher dashboard redesign — welcome-banner figures.
 *
 * The banner is a pure presentation upgrade, but it needs three figures that
 * were not on the old dashboard:
 *   • totalTestsAssigned — a single all-time, teacher-scoped Test.countDocuments;
 *   • subjectAverage     — mean of the teacher's per-subject score averages,
 *                          from a per-subject TestResult.aggregate;
 *   • classAverages      — per-class test average, derived PURELY in JS from the
 *                          already-fetched per-student rows (topRows), so a NEW
 *                          bar chart can compare the teacher's classes.
 * The two figures the banner reuses unchanged (testAverage, attendanceRate) are
 * asserted too, to lock the whole six-figure set against regressions.
 *
 * Loads the REAL routes/views/dashboard.views.js handler with mocked models.
 * The whole handler sits in a try/catch that swallows errors, so a logged
 * warning is surfaced as a test failure instead of rendering silent zeros.
 */

const mockDaysAgo = (n) => new Date(Date.now() - n * 86400000);

// One subject, two classes (both grade 9) — enough to prove the per-class split.
const mockAssignments = [
  { teacher: "t1", subject: { _id: "s1", name: "Math" }, classLevel: { _id: "c1", name: "Class 9A", gradeLevel: "9", group: null, section: null } },
  { teacher: "t1", subject: { _id: "s1", name: "Math" }, classLevel: { _id: "c2", name: "Class 9B", gradeLevel: "9", group: null, section: null } },
];

// Per-student rows (topRows). Weighted overall = (80*2 + 60*2 + 90*1) / 5 = 74.0.
// Per-class: c1 = 280/4 = 70.0, c2 = 90/1 = 90.0.
const mockTopRows = [
  { _id: "X1", name: "A", rollNumber: "1", classLevel: "c1", parentName: "", tests: 2, avg: 80 },
  { _id: "X2", name: "B", rollNumber: "2", classLevel: "c1", parentName: "", tests: 2, avg: 60 },
  { _id: "X3", name: "C", rollNumber: "3", classLevel: "c2", parentName: "", tests: 1, avg: 90 },
];
// Per-subject rows (subjectScoreAgg): a single subject → subjectAverage = 76.6.
const mockSubjectRows = [{ _id: "s1", avg: 76.6, count: 5 }];
// 30-day attendance (present 80 + late 10 / total 100) → attendanceRate 90.0.
const mockTrendRows = [{ _id: "2026-11-01", present: 80, absent: 10, late: 10 }];
const mockLifetimeRows = [{ _id: "X1", present: 20, absent: 2, late: 1 }];

const mockWarns = [];

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

jest.mock("../config/logger", () => ({
  warn: (...a) => mockWarns.push(a.join(" | ")),
  error: (...a) => mockWarns.push(a.join(" | ")),
  info: () => {},
}));

jest.mock("../models/Academic/assignment.model", () => ({
  find: () => mockChain(mockAssignments),
}));
jest.mock("../models/Academic/test.model", () => ({
  // Overdue + this-week lists are irrelevant here; empty keeps the marking block
  // short-circuited. The count feeds the banner's "tests assigned" figure.
  find: () => mockChain([]),
  countDocuments: () => Promise.resolve(12),
}));
jest.mock("../models/Students/students.model", () => ({
  find: () => mockChain([]),
  countDocuments: () => Promise.resolve(30),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: () => mockChain([]),
  // Promise.all fires topRows first, then the per-subject aggregation.
  aggregate: jest
    .fn()
    .mockResolvedValueOnce(mockTopRows)
    .mockResolvedValueOnce(mockSubjectRows),
}));
jest.mock("../models/Academic/attendance.model", () => ({
  find: () => mockChain([]),
  // Promise.all fires the 30-day trend first, then the lifetime per-student map.
  aggregate: jest
    .fn()
    .mockResolvedValueOnce(mockTrendRows)
    .mockResolvedValueOnce(mockLifetimeRows),
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
jest.mock("../services/alerts/atRiskAlerts.service", () => ({
  getAtRiskStudentsAdmin: jest.fn(),
  getAtRiskStudentsTeacher: jest.fn().mockResolvedValue({ students: [], total: 0 }),
  THRESHOLDS: {},
}));
jest.mock("../services/academic/markingFollowUp.service", () => {
  const real = jest.requireActual("../services/academic/markingFollowUp.service");
  return {
    getPendingMarkingAllTeachers: jest.fn().mockResolvedValue([]),
    getTeacherTestMarkingSummary: jest.fn().mockResolvedValue([]),
    isBeyondMarkingGrace: real.isBeyondMarkingGrace,
  };
});

const router = require("../routes/views/dashboard.views.js");

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
    render: (view, data) => { rendered.view = view; rendered.data = data; },
    redirect: () => {},
  };
  return dashboardHandler()(
    { user: { _id: "t1", role: "teacher" }, query: {}, body: {}, params: {} },
    res
  ).then(() => rendered);
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("teacher dashboard — welcome-banner figures", () => {
  let stats;

  beforeAll(async () => {
    const rendered = await renderTeacherDashboard();
    expect(mockWarns).toEqual([]);
    expect(rendered.view).toBe("dashboard");
    stats = rendered.data.stats.teacher;
  });

  it("reports the all-time teacher-scoped tests-assigned count", () => {
    expect(stats.totalTestsAssigned).toBe(12);
  });

  it("computes the subject average as the mean of per-subject averages", () => {
    expect(stats.subjectAverage).toBe(76.6);
  });

  it("derives a per-class test-average breakdown from the existing rows (no new query)", () => {
    expect(stats.classAverages).toEqual([
      { class: "Class 9A", gradeLevel: "9", avg: 70, students: 2 },
      { class: "Class 9B", gradeLevel: "9", avg: 90, students: 1 },
    ]);
  });

  it("keeps the reused figures the banner depends on unchanged", () => {
    expect(stats.testAverage).toBe(74);     // weighted across all classes
    expect(stats.attendanceRate).toBe(90);  // (present + late) / total, 30 days
    expect(stats.totalClasses).toBe(2);
  });
});
