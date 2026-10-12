/**
 * Analytics PDF report modes — single week / multi-week / full phase.
 *
 * The analytics report reshapes itself around the chosen period scope:
 *   • single-week: results live in one week  → flat test list;
 *   • full-phase : phaseId set, no week selector → exactly one subject, one
 *                  row per student and one column per test (the pivot), subject
 *                  name printed once above the table;
 *   • multi-week : 2+ weeks in the results → subject groups, ONE aggregated
 *                  row per week (scores + out-of summed);
 *   • percentages use (score / outOf * 100).toFixed(1), "N/A" when out-of is 0.
 *
 * Pure helpers run straight from _analyticsInternals; the gathering +
 * rendering pipeline is driven end-to-end with mocked models (no DB), the
 * same pattern as reaudit_pdf_export.test.js.
 */

const mockTestFind = jest.fn();
const mockTestResultFind = jest.fn();
const mockTestSessionFindById = jest.fn();
const mockWeekFind = jest.fn();
const mockWeekFindById = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  find: (...a) => mockTestFind(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockTestResultFind(...a),
}));
jest.mock("../models/Academic/testSession.model", () => ({
  findById: (...a) => mockTestSessionFindById(...a),
}));
jest.mock("../models/Academic/week.model", () => ({
  find: (...a) => mockWeekFind(...a),
  findById: (...a) => mockWeekFindById(...a),
}));

const pdfReport = require("../services/academic/pdfReport.service");
const {
  detectAnalyticsMode,
  isFullPhasePeriod,
  analyticsPercentLabel,
  groupRowsByStudent,
  buildSubjectWeekGroups,
  buildFullPhasePivot,
} = pdfReport._analyticsInternals;

const SESSION = "507f1f77bcf86cd799439000";
const PHASE_1 = "507f1f77bcf86cd799439001";
const WEEK_A = "507f1f77bcf86cd799439011";
const WEEK_B = "507f1f77bcf86cd799439012";

const row = (over = {}) => ({
  studentName: "Alice",
  studentId: "S1",
  rollNumber: "1",
  test: "Test 1",
  subject: "Math",
  date: new Date("2026-03-02"),
  score: 40,
  totalMarks: 50,
  percent: 80,
  weekId: WEEK_A,
  weekName: "Week A",
  weekStart: new Date("2026-03-01"),
  ...over,
});

// ═════════════════════════════════════════════════════════════════════════════
// Mode detection
// ═════════════════════════════════════════════════════════════════════════════
describe("detectAnalyticsMode", () => {
  test("results from a single week are single-week, even with a phase picked", () => {
    const rows = [row(), row({ test: "Test 2" })];
    expect(detectAnalyticsMode(rows, { phaseId: PHASE_1, weekId: WEEK_A })).toBe("single-week");
  });

  test("no week metadata at all still counts as one bucket → single-week", () => {
    const rows = [row({ weekId: null }), row({ weekId: null })];
    expect(detectAnalyticsMode(rows, {})).toBe("single-week");
  });

  test("phaseId with no week selector and 2+ weeks → full-phase", () => {
    const rows = [row(), row({ weekId: WEEK_B, weekName: "Week B" })];
    expect(detectAnalyticsMode(rows, { phaseId: PHASE_1 })).toBe("full-phase");
  });

  test("ticked week set (2+) is multi-week even when the phase is also sent", () => {
    const rows = [row(), row({ weekId: WEEK_B })];
    expect(detectAnalyticsMode(rows, { phaseId: PHASE_1, weekIds: [WEEK_A, WEEK_B] })).toBe("multi-week");
  });

  test("two weeks with no period selectors → multi-week", () => {
    const rows = [row(), row({ weekId: WEEK_B })];
    expect(detectAnalyticsMode(rows, {})).toBe("multi-week");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Percentage formatting
// ═════════════════════════════════════════════════════════════════════════════
describe("analyticsPercentLabel", () => {
  test("(score / outOf * 100) at one decimal", () => {
    expect(analyticsPercentLabel(45, 90)).toBe("50.0%");
    expect(analyticsPercentLabel(2, 3)).toBe("66.7%");
    expect(analyticsPercentLabel(1, 3)).toBe("33.3%");
  });

  test("zero / missing out-of is N/A, never NaN or Infinity", () => {
    expect(analyticsPercentLabel(10, 0)).toBe("N/A");
    expect(analyticsPercentLabel(10, null)).toBe("N/A");
    expect(analyticsPercentLabel(0, undefined)).toBe("N/A");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Per-student sections
// ═════════════════════════════════════════════════════════════════════════════
describe("groupRowsByStudent", () => {
  test("groups rows per student and sorts roll numbers naturally (2 before 10)", () => {
    const sections = groupRowsByStudent([
      row({ studentName: "Ten", studentId: "S10", rollNumber: "10" }),
      row({ studentName: "Alice", studentId: "S1", rollNumber: "1" }),
      row({ studentName: "Two", studentId: "S2", rollNumber: "2" }),
      row({ studentName: "Alice", studentId: "S1", rollNumber: "1", test: "Test 2" }),
    ]);
    expect(sections.map((s) => s.student.rollNumber)).toEqual(["1", "2", "10"]);
    expect(sections[0].rows).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Multi-week grouping: one aggregated row per week under each subject
// ═════════════════════════════════════════════════════════════════════════════
describe("buildSubjectWeekGroups", () => {
  test("sums a week's tests into one row and totals + percentage at the bottom", () => {
    const groups = buildSubjectWeekGroups([
      row({ subject: "Math", score: 40, totalMarks: 50, weekId: WEEK_A, weekName: "Week A", weekStart: new Date("2026-03-01") }),
      row({ subject: "Math", test: "Test 1b", score: 30, totalMarks: 50, weekId: WEEK_A, weekName: "Week A", weekStart: new Date("2026-03-01") }),
      row({ subject: "Math", test: "Test 2", score: 60, totalMarks: 100, weekId: WEEK_B, weekName: "Week B", weekStart: new Date("2026-03-08") }),
      row({ subject: "English", test: "Test 3", score: 20, totalMarks: 40, weekId: WEEK_B, weekName: "Week B", weekStart: new Date("2026-03-08") }),
    ]);
    expect(groups.map((g) => g.subject)).toEqual(["English", "Math"]); // alphabetical

    const math = groups[1];
    expect(math.lines.map((l) => l.label)).toEqual(["Week A", "Week B"]); // calendar order
    expect(math.lines[0]).toMatchObject({ score: 70, outOf: 100, percent: "70.0%" });
    expect(math.totalScore).toBe(130);
    expect(math.totalOutOf).toBe(200);
    expect(math.percent).toBe("65.0%");
  });

  test("a week with zero out-of reports N/A instead of NaN", () => {
    const groups = buildSubjectWeekGroups([
      row({ score: 0, totalMarks: 0 }),
      row({ test: "T2", weekId: WEEK_B, totalMarks: 0 }),
    ]);
    expect(groups[0].lines[0].percent).toBe("N/A");
    expect(groups[0].percent).toBe("N/A");
  });

  test("tests without a week bucket under 'No week'", () => {
    const groups = buildSubjectWeekGroups([row({ weekId: null, weekName: null, weekStart: null })]);
    expect(groups[0].lines[0].label).toBe("No week");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Full-phase guard: which period shape requires exactly one subject
// ═════════════════════════════════════════════════════════════════════════════
describe("isFullPhasePeriod", () => {
  test("a phase picked with no week narrowing is full-phase", () => {
    expect(isFullPhasePeriod({ phaseId: PHASE_1 })).toBe(true);
  });

  test("a single week or a ticked week set is never full-phase", () => {
    expect(isFullPhasePeriod({ phaseId: PHASE_1, weekId: WEEK_A })).toBe(false);
    expect(isFullPhasePeriod({ phaseId: PHASE_1, weekIds: [WEEK_A, WEEK_B] })).toBe(false);
  });

  test("no period at all is not full-phase", () => {
    expect(isFullPhasePeriod({})).toBe(false);
    expect(isFullPhasePeriod()).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Full-phase pivot: one row per student, one column per test
// ═════════════════════════════════════════════════════════════════════════════
describe("buildFullPhasePivot", () => {
  test("columns are tests in date order labelled Test 1 / Test 2; rows are students in roll order", () => {
    const pivot = buildFullPhasePivot([
      row({ studentName: "Alice", studentId: "S1", rollNumber: "1", testId: "t1", test: "Test Late", date: new Date("2026-03-09"), score: 50, totalMarks: 100 }),
      row({ studentName: "Alice", studentId: "S1", rollNumber: "1", testId: "t0", test: "Test Early", date: new Date("2026-03-02"), score: 40, totalMarks: 50 }),
      row({ studentName: "Two", studentId: "S2", rollNumber: "2", testId: "t0", test: "Test Early", date: new Date("2026-03-02"), score: 30, totalMarks: 50 }),
    ]);

    expect(pivot.columns.map((c) => c.label)).toEqual(["Test 1", "Test 2"]); // date order
    expect(pivot.columns.map((c) => c.test)).toEqual(["Test Early", "Test Late"]);
    expect(pivot.students.map((s) => s.rollNumber)).toEqual(["1", "2"]); // roster order

    const alice = pivot.students[0];
    expect(alice.cells).toMatchObject({ t0: { obtained: 40, outOf: 50 }, t1: { obtained: 50, outOf: 100 } });
    expect(alice.totalObtained).toBe(90);
    expect(alice.totalOutOf).toBe(150);

    // A student missing a test entirely has no cell for it at all (the renderer
    // draws a dash), rather than a 0/0 that would wrongly count toward a total.
    const two = pivot.students[1];
    expect(two.cells["t1"]).toBeUndefined();
    expect(two.totalObtained).toBe(30);
    expect(two.totalOutOf).toBe(50);
  });

  test("two distinct tests sharing a name stay separate columns (keyed off testId, never name)", () => {
    const pivot = buildFullPhasePivot([
      row({ testId: "tA", test: "Quiz", date: new Date("2026-03-02") }),
      row({ testId: "tB", test: "Quiz", date: new Date("2026-03-05") }),
    ]);
    expect(pivot.columns).toHaveLength(2);
    expect(pivot.columns.map((c) => c.key)).toEqual(["tA", "tB"]);
  });

  test("two distinct students sharing a studentId stay separate rows (keyed off the Mongo _id, never the id string)", () => {
    const pivot = buildFullPhasePivot([
      row({ studentRefId: "r1", studentId: "S1", studentName: "Alice", testId: "t1", score: 20, totalMarks: 40 }),
      row({ studentRefId: "r2", studentId: "S1", studentName: "Alicia", testId: "t1", score: 30, totalMarks: 40 }),
    ]);
    // Same human studentId "S1" but two Mongo identities → two roster rows, each
    // carrying only its own obtained/out-of (NOT a merged total).
    expect(pivot.students).toHaveLength(2);
    expect(pivot.students.map((s) => s.totalObtained).sort()).toEqual([20, 30]);
    expect(pivot.students.every((s) => s.totalOutOf === 40)).toBe(true);
  });

  test("a zero total out-of is carried as 0 so the renderer can label it N/A", () => {
    const pivot = buildFullPhasePivot([row({ testId: "t1", score: 0, totalMarks: 0 })]);
    expect(pivot.students[0].totalOutOf).toBe(0);
    expect(analyticsPercentLabel(pivot.students[0].totalObtained, pivot.students[0].totalOutOf)).toBe("N/A");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// End-to-end: period-narrowed gathering + rendering for each mode
// ═════════════════════════════════════════════════════════════════════════════
describe("generateAnalyticsPDF — period scope pipeline", () => {
  const oid = (s) => ({ toString: () => s });

  function asQuery(value) {
    const q = {
      populate: () => q,
      select: () => q,
      sort: () => q,
      lean: () => Promise.resolve(value),
      then: (res, rej) => Promise.resolve(value).then(res, rej),
    };
    return q;
  }

  const sessionDoc = { _id: oid(SESSION), name: "Spring Session", phases: [{ _id: PHASE_1, name: "1st Term", order: 1 }] };

  const testsIn = (list) => mockTestFind.mockReturnValue(asQuery(list));
  // Results are narrowed by the SERVICE's DB query (test ∈ period-filtered
  // ids), so the mock must honour the $in — otherwise a "tests were narrowed"
  // assertion would pass even if the filter never ran.
  const resultsIn = (list) =>
    mockTestResultFind.mockImplementation((query) => {
      const wanted = query && query.test && query.test.$in ? query.test.$in.map(String) : null;
      return asQuery(list.filter((r) => !wanted || wanted.includes(String(r.test._id))));
    });

  const testDoc = (id, week, name = "T") => ({
    _id: oid(id),
    name,
    date: new Date("2026-03-02"),
    totalMarks: 50,
    subject: { _id: oid("sub1"), name: "Math" },
    phase: { _id: oid(PHASE_1) },
    week: week ? { _id: oid(week), name: week === WEEK_A ? "Week A" : "Week B", startDate: new Date(week === WEEK_A ? "2026-03-01" : "2026-03-08") } : null,
  });

  const resultDoc = (student, test) => ({
    student: { _id: oid(student), name: student, studentId: `S-${student}`, rollNumber: student, photoUrl: null },
    test,
    score: 40,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockTestSessionFindById.mockReturnValue(asQuery(sessionDoc));
    mockWeekFind.mockReturnValue(asQuery([{ _id: oid(WEEK_A), name: "Week A", phase: PHASE_1 }]));
    mockWeekFindById.mockReturnValue(asQuery({ _id: oid(WEEK_A), name: "Week A", phase: PHASE_1 }));
  });

  test("phase scope renders the full-phase pivot (2+ weeks, one row per student)", async () => {
    testsIn([testDoc("t1", WEEK_A), testDoc("t2", WEEK_B)]);
    resultsIn([resultDoc("R1", testDoc("t1", WEEK_A)), resultDoc("R1", testDoc("t2", WEEK_B))]);

    const out = await pdfReport.generateAnalyticsPDF(
      { studentId: undefined, subjectId: "sub1", period: { sessionId: SESSION, phaseId: PHASE_1 } },
      "Avenir Academy",
      null
    );
    expect(out.studentCount).toBe(2);
    // The session filter must reach the Test query.
    expect(mockTestFind.mock.calls[0][0].session).toBe(SESSION);
    // The one-subject requirement must reach the Test query too.
    expect(mockTestFind.mock.calls[0][0].subject).toBe("sub1");
  });

  test("phase scope WITHOUT a subject fails closed instead of falling back to every subject (admin/manager, no scope)", async () => {
    testsIn([testDoc("t1", WEEK_A), testDoc("t2", WEEK_B)]);
    await expect(
      pdfReport.generateAnalyticsPDF(
        { subjectId: undefined, period: { sessionId: SESSION, phaseId: PHASE_1 } },
        "Avenir Academy",
        null
      )
    ).rejects.toThrow(/one subject/i);
  });

  test("phase scope WITHOUT a subject fails closed instead of falling back to every assigned subject (teacher scope)", async () => {
    testsIn([testDoc("t1", WEEK_A), testDoc("t2", WEEK_B)]);
    await expect(
      pdfReport.generateAnalyticsPDF(
        { subjectId: undefined, period: { sessionId: SESSION, phaseId: PHASE_1 } },
        "Avenir Academy",
        { subjectClassMap: {}, teacherSubjectIds: ["sub1", "sub2"] }
      )
    ).rejects.toThrow(/one subject/i);
    // It must never even reach the Test query — the guard runs first.
    expect(mockTestFind).not.toHaveBeenCalled();
  });

  test("ticked two-week scope narrows tests and renders the multi-week layout", async () => {
    const tA = testDoc("t1", WEEK_A);
    const tB = testDoc("t2", WEEK_B);
    testsIn([tA, tB, testDoc("t3", null)]);
    resultsIn([resultDoc("R1", tA), resultDoc("R1", tB), resultDoc("R1", testDoc("t3", null))]);

    const out = await pdfReport.generateAnalyticsPDF(
      { period: { sessionId: SESSION, weekIds: [WEEK_A, WEEK_B] } },
      "Avenir Academy",
      null
    );
    // t3 (outside the ticked weeks) is filtered out before results are fetched.
    expect(out.studentCount).toBe(2);
  });

  test("single-week scope with one student produces the flat single-student report", async () => {
    const tA = testDoc("t1", WEEK_A);
    const tA2 = Object.assign({}, tA, { _id: oid("t1b"), name: "T2" });
    testsIn([tA, tA2]);
    resultsIn([resultDoc("R1", tA), resultDoc("R1", tA2)]);

    const out = await pdfReport.generateAnalyticsPDF(
      { studentId: "r1", period: { sessionId: SESSION, weekId: WEEK_A } },
      "Avenir Academy",
      null
    );
    expect(out.studentCount).toBe(2);
    expect(out.singleStudent).toEqual({ name: "R1", whatsapp: undefined });
  });

  test("full-phase pivot with several students renders one row per student", async () => {
    const tA = testDoc("t1", WEEK_A);
    const tB = testDoc("t2", WEEK_B);
    testsIn([tA, tB]);
    resultsIn([resultDoc("10", tA), resultDoc("10", tB), resultDoc("2", tA), resultDoc("2", tB)]);

    const out = await pdfReport.generateAnalyticsPDF(
      { subjectId: "sub1", period: { sessionId: SESSION, phaseId: PHASE_1 } },
      "Avenir Academy",
      null
    );
    expect(out.studentCount).toBe(4); // 2 pupils × 2 tests, pivoted 1-row-per-pupil in the PDF
  });
});
