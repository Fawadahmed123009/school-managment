/**
 * Unit tests for the session-report shaping helpers that both the single and
 * bulk PDF paths share (services/academic/pdfReport.service._sessionReportInternals).
 *
 * These are pure functions over already-fetched documents — the guarantees
 * they must keep:
 *   - week beats phase when both are given (a week lives inside one phase);
 *   - only tests with a recorded score become rows (no phantom zeros);
 *   - unphased tests still surface in an explicit block (D-1);
 *   - percent division is guarded against totalMarks = 0.
 */

const {
  filterTestsByPeriod,
  buildPhaseBlocks,
  buildSessionRows,
  averagePercent,
  overallAverageOf,
} = require("../services/academic/pdfReport.service")._sessionReportInternals;

const PHASE_1 = "507f1f77bcf86cd799439001";
const PHASE_2 = "507f1f77bcf86cd799439002";
const WEEK_1A = "507f1f77bcf86cd799439011";
const WEEK_2A = "507f1f77bcf86cd799439012";

const phases = [
  { _id: PHASE_2, name: "2nd Term", order: 2 },
  { _id: PHASE_1, name: "1st Term", order: 1 },
];

const tests = [
  { _id: "t1", name: "Test 1", totalMarks: 50, phase: PHASE_1, week: WEEK_1A, subject: { name: "Math" } },
  { _id: "t2", name: "Test 2", totalMarks: 100, phase: PHASE_1, week: WEEK_2A, subject: { name: "Science" } },
  { _id: "t3", name: "Test 3", totalMarks: 100, phase: PHASE_2, week: null, subject: { name: "Math" } },
  { _id: "t4", name: "Orphan Test", totalMarks: 0, phase: null, week: null, subject: { name: "Arts" } },
];

const resultByTest = { t1: 40, t3: 55, t4: 0 };

// ── Period filter ────────────────────────────────────────────────────────────
describe("filterTestsByPeriod", () => {
  test("no period keeps every session test", () => {
    expect(filterTestsByPeriod(tests, {})).toHaveLength(4);
    expect(filterTestsByPeriod(tests)).toHaveLength(4);
  });

  test("phase period keeps only that phase's tests (orphans excluded)", () => {
    const out = filterTestsByPeriod(tests, { phaseId: PHASE_1 });
    expect(out.map((t) => t._id)).toEqual(["t1", "t2"]);
  });

  test("week period keeps only that week's tests", () => {
    const out = filterTestsByPeriod(tests, { weekId: WEEK_2A });
    expect(out.map((t) => t._id)).toEqual(["t2"]);
  });

  test("week beats phase when both are given", () => {
    // WEEK_2A lives in PHASE_1 here, but even a mismatched pair must resolve
    // to the (narrower) week rather than silently widening.
    const out = filterTestsByPeriod(tests, { phaseId: PHASE_2, weekId: WEEK_1A });
    expect(out.map((t) => t._id)).toEqual(["t1"]);
  });

  test("matches populated refs as faithfully as bare ObjectIds", () => {
    const populated = [{ _id: "x", phase: { _id: PHASE_1 }, week: { _id: WEEK_1A } }];
    expect(filterTestsByPeriod(populated, { weekId: WEEK_1A })).toHaveLength(1);
    expect(filterTestsByPeriod(populated, { phaseId: PHASE_1 })).toHaveLength(1);
  });

  // ── Feature 2: multi-week ("Selected weeks") combination ────────────────
  test("weekIds keeps ONLY the ticked weeks' tests, not the whole phase", () => {
    // WEEK_1A and WEEK_2A are both in PHASE_1 here. Ticking the two of them
    // must yield exactly those two tests — a phase tick would have widened it.
    const out = filterTestsByPeriod(tests, { weekIds: [WEEK_1A, WEEK_2A] });
    expect(out.map((t) => t._id)).toEqual(["t1", "t2"]);
  });

  test("weekIds selecting one of several weeks narrows to that week alone", () => {
    const out = filterTestsByPeriod(tests, { weekIds: [WEEK_1A] });
    expect(out.map((t) => t._id)).toEqual(["t1"]);
  });

  test("weekIds beats a single weekId and phaseId when all are present", () => {
    // Even if a stale phase/week is sent alongside the week set, the explicit
    // (narrowest) week set must win — never widen back to the phase.
    const out = filterTestsByPeriod(tests, { phaseId: PHASE_1, weekId: WEEK_1A, weekIds: [WEEK_2A] });
    expect(out.map((t) => t._id)).toEqual(["t2"]);
  });

  test("an empty weekIds array is ignored (falls through to no filter)", () => {
    // Guards against a browser posting weekIds=[] and wiping the whole report.
    expect(filterTestsByPeriod(tests, { weekIds: [] })).toHaveLength(4);
  });
});

// ── Row shaping ──────────────────────────────────────────────────────────────
describe("buildSessionRows / averagePercent", () => {
  test("only tests with a recorded result become rows", () => {
    const rows = buildSessionRows(tests, resultByTest);
    expect(rows.map((r) => r.test)).toEqual(["Test 1", "Test 3", "Orphan Test"]);
  });

  test("totalMarks = 0 yields a null percent, never NaN/Infinity", () => {
    const rows = buildSessionRows(tests.filter((t) => t._id === "t4"), resultByTest);
    expect(rows[0].percent).toBeNull();
    expect(averagePercent(rows)).toBeNull();
  });

  test("average rounds to 2 dp", () => {
    const rows = [
      { percent: 80 }, { percent: 55.555 },
    ];
    expect(averagePercent(rows)).toBe(67.78);
  });
});

// ── Phase blocks ─────────────────────────────────────────────────────────────
describe("buildPhaseBlocks", () => {
  test("blocks follow phase order and only carry scored tests", () => {
    const blocks = buildPhaseBlocks(phases, tests, resultByTest);
    expect(blocks.map((b) => b.phase)).toEqual(["1st Term", "2nd Term", "Not grouped into a phase"]);
    expect(blocks[0].tests.map((r) => r.test)).toEqual(["Test 1"]);
    expect(blocks[1].tests.map((r) => r.test)).toEqual(["Test 3"]);
    expect(blocks[2].tests.map((r) => r.test)).toEqual(["Orphan Test"]);
  });

  test("unphased block is omitted when there are no unphased tests", () => {
    const blocks = buildPhaseBlocks(phases, tests.filter((t) => t.phase), resultByTest);
    expect(blocks.map((b) => b.phase)).toEqual(["1st Term", "2nd Term"]);
  });

  test("input phase order is not mutated", () => {
    const input = phases.slice();
    buildPhaseBlocks(input, tests, resultByTest);
    expect(input.map((p) => p.name)).toEqual(["2nd Term", "1st Term"]);
  });

  test("overall average is the mean of phase averages, ignoring empty phases", () => {
    const blocks = buildPhaseBlocks(phases, tests, resultByTest);
    const overall = overallAverageOf(blocks);
    // 1st Term: 80%  |  2nd Term: 55%  |  ungrouped: null (totalMarks 0) → mean of 80 & 55
    expect(overall).toBe(67.5);
  });
});
