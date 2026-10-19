/**
 * Session Report Card — period-scope layouts (single week / multi week / full phase).
 *
 * The card now reshapes itself from the chosen period using the SAME
 * detectAnalyticsMode the analytics PDF uses:
 *   • single-week : one week in scope → flat table, one row per subject;
 *   • multi-week  : 2+ weeks → subject groups, one row per week + per-subject
 *                   Total line;
 *   • full-phase  : a phase (no week narrowing) but 2+ weeks of results → the
 *                   classic phase-column matrix, unchanged.
 *
 * buildSessionRows is unit-tested for the week metadata the detection relies
 * on; the render pipeline is driven end-to-end with mocked models (no DB) —
 * the same pattern as analyticsReportModes.test.js — asserting the mode that
 * reaches (and is echoed back by) the renderer for each scope.
 */

const mockTestFind = jest.fn();
const mockTestResultFind = jest.fn();
const mockTestSessionFindById = jest.fn();
const mockStudentFindById = jest.fn();
const mockWeekFind = jest.fn();
const mockWeekFindById = jest.fn();

jest.mock("../models/Academic/test.model", () => ({ find: (...a) => mockTestFind(...a) }));
jest.mock("../models/Academic/testResult.model", () => ({ find: (...a) => mockTestResultFind(...a) }));
jest.mock("../models/Academic/testSession.model", () => ({ findById: (...a) => mockTestSessionFindById(...a) }));
jest.mock("../models/Students/students.model", () => ({ findById: (...a) => mockStudentFindById(...a) }));
jest.mock("../models/Academic/week.model", () => ({ find: (...a) => mockWeekFind(...a), findById: (...a) => mockWeekFindById(...a) }));

const pdfReport = require("../services/academic/pdfReport.service");
const { buildSessionRows, averagePercent, buildPhaseBlocks } = pdfReport._sessionReportInternals;
const { detectAnalyticsMode, buildSubjectWeekGroups } = pdfReport._analyticsInternals;

const SESSION = "507f1f77bcf86cd799439000";
const PHASE_1 = "507f1f77bcf86cd799439001";
const WEEK_A = "507f1f77bcf86cd799439011";
const WEEK_B = "507f1f77bcf86cd799439012";

const oid = (s) => ({ toString: () => s, _id: { toString: () => s } });

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

// ─────────────────────────────────────────────────────────────────────────────
// buildSessionRows — week metadata must survive so mode detection can see it
// ─────────────────────────────────────────────────────────────────────────────
describe("buildSessionRows — week metadata", () => {
  const tests = [
    { _id: "t1", name: "T1", totalMarks: 50, subject: { name: "Math" }, week: oid(WEEK_A) },
    { _id: "t2", name: "T2", totalMarks: 50, subject: { name: "Math" }, week: null },
  ];
  // oid(x)._id.toString() returns x, so a populated week yields a real weekId;
  // give t1 a name/start so the grouping label is available too.
  tests[0].week = { _id: oid(WEEK_A), name: "Week A", startDate: new Date("2026-03-01") };

  const resultByTest = { t1: 40, t2: 30 };

  test("populated week → weekId/weekName/weekStart on the row", () => {
    const rows = buildSessionRows(tests, resultByTest);
    expect(rows[0]).toMatchObject({ weekId: WEEK_A, weekName: "Week A" });
    expect(rows[0].weekStart).toEqual(new Date("2026-03-01"));
  });

  test("no week → null week fields (never undefined, never throws)", () => {
    const rows = buildSessionRows(tests, resultByTest);
    expect(rows[1].weekId).toBeNull();
    expect(rows[1].weekName).toBeNull();
    expect(rows[1].weekStart).toBeNull();
  });

  test("percent division stays guarded for a zero-total test", () => {
    const rows = buildSessionRows([{ _id: "z", name: "Z", totalMarks: 0, subject: { name: "Arts" }, week: null }], { z: 0 });
    expect(rows[0].percent).toBeNull();
  });

  test("{ score, absent } entry → row carries the flag with percent 0 (counts as 0%)", () => {
    const rows = buildSessionRows(
      [{ _id: "t1", name: "T1", totalMarks: 50, subject: { name: "Math" }, week: null }],
      { t1: { score: 0, absent: true } }
    );
    // On the Session Report Card an absence is kept visible (absent:true → "A")
    // but counts as a real 0% toward the average, so percent is 0 not null.
    expect(rows[0]).toMatchObject({ absent: true, score: 0, percent: 0 });
  });

  test("{ score:0, absent:false } (genuine 0) → percent 0, still counts", () => {
    const rows = buildSessionRows(
      [{ _id: "t1", name: "T1", totalMarks: 50, subject: { name: "Math" }, week: null }],
      { t1: { score: 0, absent: false } }
    );
    expect(rows[0]).toMatchObject({ absent: false, score: 0, percent: 0 });
  });

  test("a bare-number entry (legacy shape) is treated as present", () => {
    const rows = buildSessionRows(
      [{ _id: "t1", name: "T1", totalMarks: 50, subject: { name: "Math" }, week: null }],
      { t1: 40 }
    );
    expect(rows[0]).toMatchObject({ absent: false, score: 40, percent: 80 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Absent counts as 0: an absence stays shown as "A" but is averaged in as a real
// 0% attempt, dragging every session/phase/subject average down.
// ─────────────────────────────────────────────────────────────────────────────
describe("session card absence handling (absent counts as 0%)", () => {
  const testDocs = [
    { _id: "t1", name: "T1", totalMarks: 50, subject: { name: "Math" }, week: null, phase: null },
    { _id: "t2", name: "T2", totalMarks: 50, subject: { name: "Math" }, week: null, phase: null },
  ];

  test("averagePercent counts an absent row as 0 alongside a genuine 0 (two tests, both 0%)", () => {
    const rows = buildSessionRows(testDocs, {
      t1: { score: 0, absent: true },   // absent → 0%
      t2: { score: 0, absent: false },  // genuine 0 → 0%
    });
    // Both rows now enter the average (denominator is TWO, not one); each is 0%.
    expect(rows[0].absent).toBe(true);
    expect(rows[0].percent).toBe(0);
    expect(rows[1].percent).toBe(0);
    expect(averagePercent(rows)).toBe(0);
  });

  test("an absence drags the average down: marked 80% + absent 0% → 40", () => {
    const rows = buildSessionRows(testDocs, {
      t1: { score: 40, absent: false },
      t2: { score: 0, absent: true },
    });
    // The absence is averaged in as a 0%, so the single 80% is halved to 40.
    expect(averagePercent(rows)).toBe(40);
  });

  test("buildPhaseBlocks phase average counts absences as 0", () => {
    const blocks = buildPhaseBlocks(
      [{ _id: "p1", name: "Phase 1", order: 1 }],
      testDocs.map((t) => ({ ...t, phase: { _id: "p1" } })),
      { t1: { score: 40, absent: false }, t2: { score: 0, absent: true } }
    );
    // 80% and an absent 0% → phase average of 40.
    expect(blocks[0].average).toBe(40);
  });

  test("buildSubjectWeekGroups with absentAsZero pulls an absence into the denominator", () => {
    const rows = [
      { subject: "Math", test: "T1", score: 40, totalMarks: 50, weekId: WEEK_A, weekName: "Week A", weekStart: new Date("2026-03-01") },
      { subject: "Math", test: "T2", score: 0, totalMarks: 50, absent: true, weekId: WEEK_A, weekName: "Week A", weekStart: new Date("2026-03-01") },
    ];
    // Session-card mode: the absence adds its 50 marks to the denominator only →
    // 40/100 = 40.0% (the marked 40/50 alone would have been 80.0%).
    const groups = buildSubjectWeekGroups(rows, { absentAsZero: true });
    expect(groups[0].totalScore).toBe(40);
    expect(groups[0].totalOutOf).toBe(100);
    expect(groups[0].percent).toBe("40.0%");
    // The week still has a marked test, so the line itself is not flagged fully
    // absent (that flag only shows a lone "A" when NO test in the week is marked).
    expect(groups[0].lines[0].absent).toBe(false);
  });

  test("buildSubjectWeekGroups default (analytics) still EXCLUDES the absence — no leak", () => {
    const rows = [
      { subject: "Math", test: "T1", score: 40, totalMarks: 50, weekId: WEEK_A, weekName: "Week A", weekStart: new Date("2026-03-01") },
      { subject: "Math", test: "T2", score: 0, totalMarks: 50, absent: true, weekId: WEEK_A, weekName: "Week A", weekStart: new Date("2026-03-01") },
    ];
    const groups = buildSubjectWeekGroups(rows);
    expect(groups[0].totalScore).toBe(40);
    expect(groups[0].totalOutOf).toBe(50);
    expect(groups[0].percent).toBe("80.0%");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mode wiring: the detection the session card reuses is detectAnalyticsMode.
// ─────────────────────────────────────────────────────────────────────────────
describe("session card mode selection (shared with analytics)", () => {
  const row = (over = {}) => ({
    test: "T1", subject: "Math", score: 40, totalMarks: 50, percent: 80,
    weekId: WEEK_A, weekName: "Week A", weekStart: new Date("2026-03-01"), ...over,
  });

  test("one week of results → single-week", () => {
    expect(detectAnalyticsMode([row(), row({ test: "T2" })], { weekId: WEEK_A })).toBe("single-week");
  });

  test("ticked two weeks (no phase) → multi-week", () => {
    expect(detectAnalyticsMode([row(), row({ weekId: WEEK_B })], { weekIds: [WEEK_A, WEEK_B] })).toBe("multi-week");
  });

  test("phase scope, no week narrowing, 2+ weeks → full-phase", () => {
    expect(detectAnalyticsMode([row(), row({ weekId: WEEK_B })], { phaseId: PHASE_1 })).toBe("full-phase");
  });

  test("single-week collapses to one aggregated row per subject via buildSubjectWeekGroups", () => {
    const groups = buildSubjectWeekGroups([row({ score: 40, totalMarks: 50 }), row({ test: "T2", score: 30, totalMarks: 50 })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].subject).toBe("Math");
    expect(groups[0].totalScore).toBe(70);
    expect(groups[0].totalOutOf).toBe(100);
    expect(groups[0].percent).toBe("70.0%");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end render pipeline for each scope (mocked models, real pdfkit)
// ─────────────────────────────────────────────────────────────────────────────
describe("generateSessionReportPDF — layout mode reaches the renderer per scope", () => {
  const sessionDoc = { _id: oid(SESSION), name: "Spring Session", phases: [{ _id: oid(PHASE_1), name: "1st Term", order: 1 }] };
  const studentDoc = { _id: oid("stu1"), name: "Alice", studentId: "S-1", rollNumber: "1", whatsappNumber: null, fatherName: "Bob", classLevel: null, photoUrl: null };

  function testDoc(id, week, phase = PHASE_1) {
    return {
      _id: oid(id),
      name: `Test ${id}`,
      totalMarks: 50,
      date: new Date("2026-03-02"),
      subject: { _id: oid("sub1"), name: "Math" },
      phase: phase ? { _id: oid(phase) } : null,
      week: week ? { _id: oid(week), name: week === WEEK_A ? "Week A" : "Week B", startDate: new Date(week === WEEK_A ? "2026-03-01" : "2026-03-08") } : null,
    };
  }

  function resultsFor(tests) {
    // resultByTest is keyed by r.test.toString(); every test has a recorded score.
    return tests.map((t) => ({ test: { toString: () => String(t._id) }, score: 40 }));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockTestSessionFindById.mockReturnValue(asQuery(sessionDoc));
    mockStudentFindById.mockReturnValue(asQuery(studentDoc));
    mockWeekFind.mockReturnValue(asQuery([{ _id: oid(WEEK_A), name: "Week A", phase: PHASE_1 }, { _id: oid(WEEK_B), name: "Week B", phase: PHASE_1 }]));
    mockWeekFindById.mockReturnValue(asQuery({ _id: oid(WEEK_A), name: "Week A", phase: PHASE_1 }));
  });

  test("single-week scope renders the flat layout (mode echoed back)", async () => {
    const tests = [testDoc("t1", WEEK_A), testDoc("t2", WEEK_A)];
    mockTestFind.mockReturnValue(asQuery(tests));
    mockTestResultFind.mockReturnValue(asQuery(resultsFor(tests)));

    const out = await pdfReport.generateSessionReportPDF(SESSION, "stu1", "Avenir Academy", { weekId: WEEK_A });
    expect(out.mode).toBe("single-week");
    expect(out.studentCount).toBe(1);
  });

  test("multi-week scope renders the grouped weekly layout", async () => {
    const tests = [testDoc("t1", WEEK_A), testDoc("t2", WEEK_B)];
    mockTestFind.mockReturnValue(asQuery(tests));
    mockTestResultFind.mockReturnValue(asQuery(resultsFor(tests)));

    const out = await pdfReport.generateSessionReportPDF(SESSION, "stu1", "Avenir Academy", { weekIds: [WEEK_A, WEEK_B] });
    expect(out.mode).toBe("multi-week");
  });

  test("full-phase scope keeps the classic matrix layout", async () => {
    const tests = [testDoc("t1", WEEK_A), testDoc("t2", WEEK_B)];
    mockTestFind.mockReturnValue(asQuery(tests));
    mockTestResultFind.mockReturnValue(asQuery(resultsFor(tests)));

    const out = await pdfReport.generateSessionReportPDF(SESSION, "stu1", "Avenir Academy", { phaseId: PHASE_1 });
    expect(out.mode).toBe("full-phase");
  });

  test("a student with no scored tests yields an empty (no-throw) single-week card", async () => {
    mockTestFind.mockReturnValue(asQuery([testDoc("t1", WEEK_A)]));
    mockTestResultFind.mockReturnValue(asQuery([])); // no results

    const out = await pdfReport.generateSessionReportPDF(SESSION, "stu1", "Avenir Academy", { weekId: WEEK_A });
    expect(out.mode).toBe("single-week");
    expect(out.studentCount).toBe(1);
  });
});
