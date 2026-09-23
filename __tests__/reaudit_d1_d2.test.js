/**
 * Verification tests — PART 2 batch (audit re-audit).
 *
 * Each test drives the REAL service logic with mocked data-layer models
 * (same pattern as atRiskAlerts.test.js / testAnalytics.test.js) and asserts
 * the FIXED behaviour. A "before" reproduction is included where it is a pure
 * function so the regression is demonstrated concretely.
 *
 * Covers:
 *   D-2  buildDistribution  — totalMarks = 0 no longer divides by zero.
 *   D-2  getTestAnalyticsService — percent is null (not NaN) for totalMarks 0.
 *   D-1  getSessionReportCardService — phase:null tests are surfaced in an
 *        explicit "Not grouped into a phase" block; totalMarks 0 → null %.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockTestFind = jest.fn();
const mockTestResultFind = jest.fn();
const mockTestSessionFindById = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  find: (...a) => mockTestFind(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockTestResultFind(...a),
}));
jest.mock("../models/Academic/testSession.model", () => ({
  findById: (...a) => mockTestSessionFindById(...a),
}));

const {
  buildDistribution,
  getTestAnalyticsService,
  getSessionReportCardService,
} = require("../services/academic/test.service");

// Thenable chainable so `await Model.find(...).populate().lean()` resolves to value.
function asQuery(value) {
  const q = {
    populate: () => q,
    lean: () => Promise.resolve(value),
    sort: () => q,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return q;
}

// Fake express res that captures the responseStatus payload.
function captureRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockImplementation((body) => {
    res._body = body;
    return res;
  });
  return res;
}

beforeEach(() => jest.clearAllMocks());

// ═════════════════════════════════════════════════════════════════════════════
// D-2 — buildDistribution (pure function, exported)
// ═════════════════════════════════════════════════════════════════════════════
describe("D-2 buildDistribution — totalMarks = 0", () => {
  test("BEFORE (old inline logic) crashes with a TypeError on totalMarks = 0", () => {
    // Replays the original algorithm verbatim to prove the bug was real.
    const oldBuild = (scores, totalMarks) => {
      if (!scores || scores.length === 0) return [];
      const bucketCount = 10;
      const bucketSize = totalMarks / bucketCount;
      const buckets = [];
      for (let i = 0; i < bucketCount; i++) {
        buckets.push({ label: `${Math.round(i * bucketSize)}–${Math.round((i + 1) * bucketSize)}`, count: 0 });
      }
      scores.forEach((s) => {
        let idx = Math.floor((s / totalMarks) * bucketCount); // s/0 → Infinity
        if (idx >= bucketCount) idx = bucketCount - 1;
        if (idx < 0) idx = 0;
        buckets[idx].count++; // buckets[Infinity] is undefined → TypeError
      });
      return buckets;
    };
    expect(() => oldBuild([50, 0], 0)).toThrow(TypeError);
  });

  test("AFTER — fixed guard returns [] instead of crashing", () => {
    expect(buildDistribution([50, 0], 0)).toEqual([]);
    expect(buildDistribution([50, 0], undefined)).toEqual([]);
    // Regression guard: normal case still works.
    expect(buildDistribution([50, 60, 70, 80, 90], 100)).toHaveLength(10);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D-2 — getTestAnalyticsService percent guard
// ═════════════════════════════════════════════════════════════════════════════
describe("D-2 getTestAnalyticsService — percent guard on totalMarks = 0", () => {
  test("a zero-totalMarks test yields percent = null, not NaN/Infinity", async () => {
    mockTestFind.mockReturnValue(asQuery([]));
    mockTestResultFind.mockReturnValue(
      asQuery([
        { student: { name: "A" }, test: { name: "Zero", subject: { name: "Math" }, date: new Date(), totalMarks: 0 }, score: 5 },
        { student: { name: "B" }, test: { name: "Normal", subject: { name: "Math" }, date: new Date(), totalMarks: 100 }, score: 42.5 },
      ])
    );

    const res = captureRes();
    await getTestAnalyticsService({}, res);

    const summary = res._body.data;
    expect(summary[0].percent).toBeNull();          // was NaN before the guard
    expect(summary[1].percent).toBe(42.5);          // normal case unaffected
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D-1 + D-2 — getSessionReportCardService
// ═════════════════════════════════════════════════════════════════════════════
describe("D-1/D-2 getSessionReportCardService", () => {
  const oid = (s) => ({ toString: () => s });

  test("phase:null tests appear in a 'Not grouped into a phase' block", async () => {
    mockTestSessionFindById.mockResolvedValue({
      _id: oid("sess1"),
      name: "Term 1",
      phases: [{ _id: oid("ph1"), name: "Phase 1", order: 1 }],
    });
    mockTestFind.mockReturnValue(
      asQuery([
        { _id: oid("t1"), name: "Grouped test", subject: { name: "Math" }, totalMarks: 100, phase: oid("ph1") },
        { _id: oid("t2"), name: "Ungrouped test", subject: { name: "Math" }, totalMarks: 100, phase: null },
        { _id: oid("t3"), name: "Legacy zero-total", subject: { name: "Math" }, totalMarks: 0, phase: oid("ph1") },
      ])
    );
    mockTestResultFind.mockReturnValue(
      asQuery([
        { test: oid("t1"), score: 80 },
        { test: oid("t2"), score: 55 },
        { test: oid("t3"), score: 30 },
      ])
    );

    const res = captureRes();
    await getSessionReportCardService("sess1", "student1", res);
    const report = res._body.data;

    // D-1: the ungrouped test is no longer silently dropped.
    const ungrouped = report.phases.find((p) => p.phase === "Not grouped into a phase");
    expect(ungrouped).toBeDefined();
    expect(ungrouped.tests.map((t) => t.test)).toContain("Ungrouped test");
    expect(ungrouped.average).toBe(55);

    // D-2: zero-totalMarks test renders a null percent (not NaN) and is excluded
    // from its phase average, so the phase average is just the valid row (80).
    const phase1 = report.phases.find((p) => p.phase === "Phase 1");
    const legacy = phase1.tests.find((t) => t.test === "Legacy zero-total");
    expect(legacy.percent).toBeNull();
    expect(phase1.average).toBe(80);
  });

  test("no ungrouped tests → no 'Not grouped into a phase' block", async () => {
    mockTestSessionFindById.mockResolvedValue({
      _id: oid("sess1"), name: "Term 1",
      phases: [{ _id: oid("ph1"), name: "Phase 1", order: 1 }],
    });
    mockTestFind.mockReturnValue(
      asQuery([{ _id: oid("t1"), name: "Grouped", subject: { name: "Math" }, totalMarks: 100, phase: oid("ph1") }])
    );
    mockTestResultFind.mockReturnValue(asQuery([{ test: oid("t1"), score: 70 }]));

    const res = captureRes();
    await getSessionReportCardService("sess1", "student1", res);
    expect(res._body.data.phases.find((p) => p.phase === "Not grouped into a phase")).toBeUndefined();
  });
});
