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
      { subject: "Science", count: 1, average: 90 },
      { subject: "Math", count: 2, average: 70 },
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

    expect(marks.bySubject).toEqual([{ subject: "Unknown", count: 1, average: 90 }]);
  });

  test("empty test results yield empty bySubject and progress arrays", async () => {
    mockTestResultFind.mockReturnValue(withPopulate([]));

    const { marks } = await getStudentAnalysisService("s1", {});

    expect(marks.bySubject).toEqual([]);
    expect(marks.progress).toEqual([]);
    expect(marks.overallAverage).toBeNull();
  });
});
