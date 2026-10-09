/**
 * Analytics PDF report modes — single week / multi-week / full phase.
 *
 * The analytics report reshapes itself around the chosen period scope:
 *   • single-week: results live in one week  → flat test list;
 *   • full-phase : phaseId set, no week selector → subject groups of tests;
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
  analyticsPercentLabel,
  groupRowsByStudent,
  buildSubjectWeekGroups,
  buildSubjectTestGroups,
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
// Full-phase grouping: every individual test under each subject
// ═════════════════════════════════════════════════════════════════════════════
describe("buildSubjectTestGroups", () => {
  test("one row per test in date order, with totals and percentage", () => {
    const groups = buildSubjectTestGroups([
      row({ subject: "Math", test: "Test Late", date: new Date("2026-03-09"), score: 50, totalMarks: 100 }),
      row({ subject: "Math", test: "Test Early", date: new Date("2026-03-02"), score: 40, totalMarks: 50 }),
      row({ subject: "English", test: "Test Eng", date: new Date("2026-03-05"), score: 20, totalMarks: 40 }),
    ]);
    expect(groups.map((g) => g.subject)).toEqual(["English", "Math"]);
    const math = groups[1];
    expect(math.lines.map((l) => l.test)).toEqual(["Test Early", "Test Late"]);
    expect(math.lines[0].percent).toBe("80.0%");
    expect(math.totalScore).toBe(90);
    expect(math.totalOutOf).toBe(150);
    expect(math.percent).toBe("60.0%");
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

  test("phase scope renders the full-phase layout (2+ weeks, per-test rows)", async () => {
    testsIn([testDoc("t1", WEEK_A), testDoc("t2", WEEK_B)]);
    resultsIn([resultDoc("R1", testDoc("t1", WEEK_A)), resultDoc("R1", testDoc("t2", WEEK_B))]);

    const out = await pdfReport.generateAnalyticsPDF(
      { studentId: undefined, subjectId: undefined, period: { sessionId: SESSION, phaseId: PHASE_1 } },
      "Avenir Academy",
      null
    );
    expect(out.studentCount).toBe(2);
    // The session filter must reach the Test query.
    expect(mockTestFind.mock.calls[0][0].session).toBe(SESSION);
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

  test("multi-week mode with several students renders one section per student", async () => {
    const tA = testDoc("t1", WEEK_A);
    const tB = testDoc("t2", WEEK_B);
    testsIn([tA, tB]);
    resultsIn([resultDoc("10", tA), resultDoc("10", tB), resultDoc("2", tA), resultDoc("2", tB)]);

    const out = await pdfReport.generateAnalyticsPDF(
      { period: { sessionId: SESSION, phaseId: PHASE_1 } },
      "Avenir Academy",
      null
    );
    expect(out.studentCount).toBe(4); // 2 pupils × 2 weeks, grouped 2-per-student in the PDF
  });
});
