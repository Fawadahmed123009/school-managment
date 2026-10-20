/**
 * Tests the analysis aggregations added to getStudentAnalysisService:
 *
 *   • marks.bySubject — average % per subject, rolled up across every test
 *     (replacing the old flat, repeating per-row subject column), sorted by
 *     average descending.
 *   • marks.progress  — the per-session averages exposed as a series ordered
 *     chronologically (by each session's earliest test date) so the UI can plot
 *     a trend line.
 *
 * All model modules are mocked at the data layer, so the real aggregation logic
 * executes with no database. responseStatus is mocked to return its payload so
 * the service's computed result is inspectable.
 */

// ── responseStatus: hand back the 4th arg (the payload) so we can assert on it ──
jest.mock("../handlers/responseStatus.handler", () =>
  jest.fn((res, code, status, data) => data)
);

// ── Model mocks ───────────────────────────────────────────────────────────────
const mockStudentFindById = jest.fn();
const mockAttendanceFind = jest.fn();
const mockTestResultFind = jest.fn();
const mockFeesFind = jest.fn();

jest.mock("../models/Students/students.model", () => ({
  findById: (...a) => mockStudentFindById(...a),
}));
jest.mock("../models/Academic/attendance.model", () => ({
  find: (...a) => mockAttendanceFind(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockTestResultFind(...a),
}));
jest.mock("../models/Fees/fees.model", () => ({
  find: (...a) => mockFeesFind(...a),
}));

const {
  getStudentAnalysisService,
} = require("../services/students/studentAnalysis.service");

// findById(...).populate(...) → student doc ; find(...).populate(...) → results
const withPopulate = (value) => ({ populate: jest.fn().mockResolvedValue(value) });

beforeEach(() => {
  jest.clearAllMocks();
  mockStudentFindById.mockReturnValue(
    withPopulate({ _id: "s1", name: "Kid", studentId: "R-1", classLevel: null, photoUrl: null })
  );
  mockAttendanceFind.mockResolvedValue([]);
  mockFeesFind.mockReturnValue(withPopulate([]));
});

describe("getStudentAnalysisService — subject & progress aggregation", () => {
  test("averages percent per subject and orders subjects by average descending", async () => {
    mockTestResultFind.mockReturnValue(
      withPopulate([
        { score: 80, test: { name: "T1a", subject: { name: "Math" }, session: { name: "Term 1" }, totalMarks: 100, date: "2026-01-10" } }, // 80%
        { score: 30, test: { name: "T1b", subject: { name: "Math" }, session: { name: "Term 1" }, totalMarks: 50, date: "2026-01-20" } },  // 60%
        { score: 90, test: { name: "T2a", subject: { name: "Science" }, session: { name: "Term 2" }, totalMarks: 100, date: "2026-03-05" } }, // 90%
      ])
    );

    const { marks } = await getStudentAnalysisService("s1", {});

    // Science (90) outranks Math (avg of 80 & 60 = 70)
    expect(marks.bySubject).toEqual([
      { subject: "Science", label: "Science", count: 1, average: 90 },
      { subject: "Math", label: "Math", count: 2, average: 70 },
    ]);
    expect(marks.overallAverage).toBe(76.67); // (80 + 60 + 90) / 3
  });

  test("progress series carries per-session averages ordered by earliest test date", async () => {
    // Deliberately feed Term 2 before Term 1 to prove the series is re-ordered
    // chronologically by each session's earliest test date, not input order.
    mockTestResultFind.mockReturnValue(
      withPopulate([
        { score: 90, test: { name: "T2a", subject: { name: "Science" }, session: { name: "Term 2" }, totalMarks: 100, date: "2026-03-05" } },
        { score: 80, test: { name: "T1a", subject: { name: "Math" }, session: { name: "Term 1" }, totalMarks: 100, date: "2026-01-10" } },
        { score: 30, test: { name: "T1b", subject: { name: "Math" }, session: { name: "Term 1" }, totalMarks: 50, date: "2026-01-20" } },
      ])
    );

    const { marks } = await getStudentAnalysisService("s1", {});

    expect(marks.progress).toEqual([
      { session: "Term 1", average: 70, date: "2026-01-10" }, // earliest test 01-10
      { session: "Term 2", average: 90, date: "2026-03-05" },
    ]);
  });

  test("falls back to 'Unknown' subject and skips tests with no totalMarks", async () => {
    mockTestResultFind.mockReturnValue(
      withPopulate([
        { score: 45, test: { name: "NoSubj", subject: null, session: { name: "Term 1" }, totalMarks: 50, date: "2026-01-10" } }, // 90%, Unknown
        { score: 10, test: { name: "NoTotal", subject: { name: "Math" }, session: { name: "Term 1" }, totalMarks: 0, date: "2026-01-11" } }, // skipped
      ])
    );

    const { marks } = await getStudentAnalysisService("s1", {});

    expect(marks.bySubject).toEqual([{ subject: "Unknown", label: "Unknown", count: 1, average: 90 }]);
  });

  test("empty test results yield empty bySubject and progress arrays", async () => {
    mockTestResultFind.mockReturnValue(withPopulate([]));

    const { marks } = await getStudentAnalysisService("s1", {});

    expect(marks.bySubject).toEqual([]);
    expect(marks.progress).toEqual([]);
    expect(marks.overallAverage).toBeNull();
  });

  test("bySubject.label uses displayName for the chart while keying stays on name",
    async () => {
      // Program-split subjects share a displayName but must average separately,
      // so `subject` keys off raw name while `label` carries displayName || name.
      mockTestResultFind.mockReturnValue(
        withPopulate([
          { score: 50, test: { name: "T1", subject: { name: "Math-IB", displayName: "Mathematics" }, session: { name: "S" }, totalMarks: 100, date: "2026-01-10" } },
          { score: 80, test: { name: "T2", subject: { name: "Math-Cam" }, session: { name: "S" }, totalMarks: 100, date: "2026-01-11" } },
        ])
      );

      const { marks } = await getStudentAnalysisService("s1", {});

      expect(marks.bySubject.map((s) => s.subject)).toEqual(["Math-Cam", "Math-IB"]); // keyed by raw name
      expect(marks.bySubject.find((s) => s.subject === "Math-IB").label).toBe("Mathematics");
      expect(marks.bySubject.find((s) => s.subject === "Math-Cam").label).toBe("Math-Cam"); // no displayName → name
    });
});

describe("getStudentAnalysisService — subjectGroups (group by subject, order tests by week)", () => {
  test("groups tests under their subject, labels with displayName, sorts groups by label", async () => {
    mockTestResultFind.mockReturnValue(
      withPopulate([
        { score: 40, test: { name: "Bio T", subject: { name: "Biology" }, session: { name: "S" }, totalMarks: 50, date: "2026-02-01", week: { name: "Week 1", startDate: "2026-02-01" } } },
        { score: 80, test: { name: "Math T", subject: { name: "Math-IB", displayName: "Mathematics" }, session: { name: "S" }, totalMarks: 100, date: "2026-01-10", week: { name: "Week 1", startDate: "2026-01-05" } } },
      ])
    );

    const { marks } = await getStudentAnalysisService("s1", {});

    // Ordered alphabetically by display label: Biology then Mathematics.
    expect(marks.subjectGroups.map((g) => g.label)).toEqual(["Biology", "Mathematics"]);
    // Group keyed by raw subject name, labelled with displayName.
    expect(marks.subjectGroups[1].subject).toBe("Math-IB");
  });

  test("orders a subject's tests chronologically by week startDate, not insertion order", async () => {
    mockTestResultFind.mockReturnValue(
      withPopulate([
        // Deliberately fed newest-week-first to prove the re-sort.
        { score: 60, test: { name: "Late", subject: { name: "Math" }, session: { name: "S" }, totalMarks: 100, date: "2026-03-20", week: { name: "Week 3", startDate: "2026-03-16" } } },
        { score: 40, test: { name: "Early", subject: { name: "Math" }, session: { name: "S" }, totalMarks: 100, date: "2026-01-10", week: { name: "Week 1", startDate: "2026-01-05" } } },
        { score: 50, test: { name: "Mid", subject: { name: "Math" }, session: { name: "S" }, totalMarks: 100, date: "2026-02-10", week: { name: "Week 2", startDate: "2026-02-09" } } },
      ])
    );

    const { marks } = await getStudentAnalysisService("s1", {});

    const tests = marks.subjectGroups[0].tests;
    expect(tests.map((t) => t.test)).toEqual(["Early", "Mid", "Late"]);
    expect(tests.map((t) => t.weekName)).toEqual(["Week 1", "Week 2", "Week 3"]);
  });

  test("absent row keeps absent + placeholder score so UI shows \"A\", and counts as 0% in the group average", async () => {
    mockTestResultFind.mockReturnValue(
      withPopulate([
        { score: 80, absent: false, test: { name: "Present", subject: { name: "Math" }, session: { name: "S" }, totalMarks: 100, date: "2026-01-10", week: { name: "Week 1", startDate: "2026-01-05" } } },
        // Absent: stored score 0 + absent true → "A" cell, 0% in the average.
        { score: 0, absent: true, test: { name: "Skipped", subject: { name: "Math" }, session: { name: "S" }, totalMarks: 100, date: "2026-01-20", week: { name: "Week 2", startDate: "2026-01-19" } } },
      ])
    );

    const { marks } = await getStudentAnalysisService("s1", {});

    const tests = marks.subjectGroups[0].tests;
    expect(tests[1].absent).toBe(true);
    expect(tests[1].score).toBe(0);
    expect(tests[1].percent).toBe(0);
    // (80 + 0) / 2 = 40 — the absence drags the average down (absent-as-0 rule).
    expect(marks.subjectGroups[0].average).toBe(40);
  });

  test("empty results yield an empty subjectGroups array", async () => {
    mockTestResultFind.mockReturnValue(withPopulate([]));
    const { marks } = await getStudentAnalysisService("s1", {});
    expect(marks.subjectGroups).toEqual([]);
  });
});

describe("getStudentAnalysisService — current-month attendance pie", () => {
  // The service buckets records by LOCAL (Asia/Karachi) calendar month via
  // localDateKey. Build dates in that month so the assertion is timezone-stable:
  // today's record is in-month; a record ~2 months back is always excluded.
  const inThisMonth = new Date();
  const outOfMonth = new Date();
  outOfMonth.setMonth(outOfMonth.getMonth() - 2);

  test("counts only current-month records into attendance.currentMonth", async () => {
    mockAttendanceFind.mockResolvedValue([
      { status: "present", date: inThisMonth },
      { status: "late", date: inThisMonth },
      { status: "absent", date: inThisMonth },
      { status: "present", date: outOfMonth }, // previous/all-time only, not this month
    ]);

    const { attendance } = await getStudentAnalysisService("s1", {});

    expect(attendance.currentMonth.present).toBe(1); // present, late, absent this month
    expect(attendance.currentMonth.totalMarked).toBe(3);
    // present + late over marked = (1 + 1) / 3 → 66.67 %
    expect(attendance.currentMonth.percent).toBe(66.67);
    // All-time still counts the older record too (4 marked) — proves the two
    // figures are independent, not the month overwriting the total.
    expect(attendance.totalMarked).toBe(4);
  });

  test("yields a null month percent when nothing is marked this month", async () => {
    mockAttendanceFind.mockResolvedValue([{ status: "present", date: outOfMonth }]);

    const { attendance } = await getStudentAnalysisService("s1", {});

    expect(attendance.currentMonth.totalMarked).toBe(0);
    expect(attendance.currentMonth.percent).toBeNull();
  });
});
