/**
 * Unit tests for computeStats and buildDistribution from test.service.js
 *
 * All expected values are computed BY HAND from the raw scores — not derived
 * from the implementation — so these tests independently verify the math.
 *
 * ── Hand computation reference ──────────────────────────────────────────────
 * Scores: [50, 60, 70, 80, 90], totalMarks = 100
 *
 *   n   = 5
 *   sum = 50 + 60 + 70 + 80 + 90 = 350
 *   avg = 350 / 5 = 70
 *   max = 90
 *   min = 50
 *
 *   Variance (population):
 *     (50-70)² = 400
 *     (60-70)² = 100
 *     (70-70)² =   0
 *     (80-70)² = 100
 *     (90-70)² = 400
 *     Sum = 1000
 *     Variance = 1000 / 5 = 200
 *   StdDev = √200 = 10√2 ≈ 14.1421356…
 *   Rounded to 2 dp: 14.14
 *
 * Distribution (totalMarks=100, 10 buckets, bucketSize=10):
 *   Bucket 0:  0–10   → count 0
 *   Bucket 1: 10–20   → count 0
 *   Bucket 2: 20–30   → count 0
 *   Bucket 3: 30–40   → count 0
 *   Bucket 4: 40–50   → count 0
 *   Bucket 5: 50–60   → count 1  (score 50: floor(50/100*10)=5 → bucket 5)
 *   Bucket 6: 60–70   → count 1  (score 60)
 *   Bucket 7: 70–80   → count 1  (score 70)
 *   Bucket 8: 80–90   → count 1  (score 80)
 *   Bucket 9: 90–100  → count 1  (score 90)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { computeStats, buildDistribution } = require("../services/academic/test.service");

// ── Helper: fake test object ────────────────────────────────────────────────
function makeTest(totalMarks) {
  return { _id: "test-mock", name: "Mock Test", totalMarks };
}

// ═════════════════════════════════════════════════════════════════════════════
// computeStats
// ═════════════════════════════════════════════════════════════════════════════
describe("computeStats", () => {
  // ── Primary: hand-crafted scores [50,60,70,80,90] out of 100 ────────────
  describe("scores = [50, 60, 70, 80, 90], totalMarks = 100", () => {
    const scores = [50, 60, 70, 80, 90];
    const mockTest = makeTest(100);
    let stats;

    beforeAll(() => {
      stats = computeStats(scores, mockTest);
    });

    test("average = 70  (350 / 5)", () => {
      expect(stats.avg).toBe(70);
    });

    test("max = 90", () => {
      expect(stats.max).toBe(90);
    });

    test("min = 50", () => {
      expect(stats.min).toBe(50);
    });

    test("stddev = 14.14  (√200, population stddev)", () => {
      // √200 = 14.142135623… → rounds to 14.14
      expect(stats.stddev).toBe(14.14);
    });

    test("count = 5", () => {
      expect(stats.count).toBe(5);
    });

    test("totalMarks = 100", () => {
      expect(stats.totalMarks).toBe(100);
    });
  });

  // ── Empty scores ──────────────────────────────────────────────────────────
  describe("empty scores array", () => {
    const stats = computeStats([], makeTest(100));

    test("avg = null", () => { expect(stats.avg).toBeNull(); });
    test("max = null", () => { expect(stats.max).toBeNull(); });
    test("min = null", () => { expect(stats.min).toBeNull(); });
    test("stddev = null", () => { expect(stats.stddev).toBeNull(); });
    test("count = 0", () => { expect(stats.count).toBe(0); });
    test("totalMarks still populated", () => { expect(stats.totalMarks).toBe(100); });
  });

  // ── null scores ───────────────────────────────────────────────────────────
  describe("null scores", () => {
    const stats = computeStats(null, makeTest(50));

    test("avg = null", () => { expect(stats.avg).toBeNull(); });
    test("count = 0", () => { expect(stats.count).toBe(0); });
    test("totalMarks = 50", () => { expect(stats.totalMarks).toBe(50); });
  });

  // ── Single score ──────────────────────────────────────────────────────────
  describe("single score [75] out of 100", () => {
    const stats = computeStats([75], makeTest(100));

    test("avg = 75", () => { expect(stats.avg).toBe(75); });
    test("max = 75", () => { expect(stats.max).toBe(75); });
    test("min = 75", () => { expect(stats.min).toBe(75); });
    test("stddev = 0  (no spread)", () => { expect(stats.stddev).toBe(0); });
    test("count = 1", () => { expect(stats.count).toBe(1); });
  });

  // ── All identical scores ──────────────────────────────────────────────────
  describe("all identical scores [60, 60, 60, 60]", () => {
    const stats = computeStats([60, 60, 60, 60], makeTest(100));

    test("avg = 60", () => { expect(stats.avg).toBe(60); });
    test("stddev = 0  (no spread)", () => { expect(stats.stddev).toBe(0); });
    test("count = 4", () => { expect(stats.count).toBe(4); });
  });

  // ── Perfect and zero scores ───────────────────────────────────────────────
  describe("boundary scores [0, 100] out of 100", () => {
    const stats = computeStats([0, 100], makeTest(100));

    test("avg = 50", () => { expect(stats.avg).toBe(50); });
    test("max = 100", () => { expect(stats.max).toBe(100); });
    test("min = 0", () => { expect(stats.min).toBe(0); });
    // variance = ((0-50)² + (100-50)²) / 2 = (2500+2500)/2 = 2500
    // stddev = √2500 = 50
    test("stddev = 50", () => { expect(stats.stddev).toBe(50); });
  });

  // ── Non-100 totalMarks ────────────────────────────────────────────────────
  describe("scores [10, 20, 30] out of 50", () => {
    const stats = computeStats([10, 20, 30], makeTest(50));

    // sum=60, avg=60/3=20, max=30, min=10
    // variance = ((10-20)² + (20-20)² + (30-20)²) / 3 = (100+0+100)/3 = 66.666…
    // stddev = √66.666… = 8.16496… → rounds to 8.16
    test("avg = 20", () => { expect(stats.avg).toBe(20); });
    test("max = 30", () => { expect(stats.max).toBe(30); });
    test("min = 10", () => { expect(stats.min).toBe(10); });
    test("stddev = 8.16", () => { expect(stats.stddev).toBe(8.16); });
    test("totalMarks = 50", () => { expect(stats.totalMarks).toBe(50); });
  });

  // ── Decimal average rounding ──────────────────────────────────────────────
  describe("scores [33, 67] out of 100 — tests rounding", () => {
    const stats = computeStats([33, 67], makeTest(100));

    // avg = 100/2 = 50 (exact)
    test("avg = 50", () => { expect(stats.avg).toBe(50); });
    // variance = ((33-50)² + (67-50)²) / 2 = (289+289)/2 = 289
    // stddev = √289 = 17 (exact)
    test("stddev = 17", () => { expect(stats.stddev).toBe(17); });
  });

  // ── Rounding to 2dp ───────────────────────────────────────────────────────
  describe("scores [1, 2, 3] out of 100 — tests rounding of repeating decimal", () => {
    const stats = computeStats([1, 2, 3], makeTest(100));

    // avg = 6/3 = 2
    test("avg = 2", () => { expect(stats.avg).toBe(2); });
    // variance = ((1-2)² + (2-2)² + (3-2)²) / 3 = (1+0+1)/3 = 0.666…
    // stddev = √0.666… = 0.81649… → rounds to 0.82
    test("stddev = 0.82", () => { expect(stats.stddev).toBe(0.82); });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildDistribution
// ═════════════════════════════════════════════════════════════════════════════
describe("buildDistribution", () => {
  // ── Primary: [50,60,70,80,90] out of 100 ─────────────────────────────────
  describe("scores = [50, 60, 70, 80, 90], totalMarks = 100", () => {
    const dist = buildDistribution([50, 60, 70, 80, 90], 100);

    test("produces exactly 10 buckets", () => {
      expect(dist).toHaveLength(10);
    });

    test("bucket labels are correct", () => {
      const expected = ["0–10", "10–20", "20–30", "30–40", "40–50",
                        "50–60", "60–70", "70–80", "80–90", "90–100"];
      expect(dist.map(b => b.label)).toEqual(expected);
    });

    test("each of buckets 5–9 has count 1, rest have 0", () => {
      const counts = dist.map(b => b.count);
      expect(counts).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    });

    test("total count across all buckets = 5", () => {
      const total = dist.reduce((sum, b) => sum + b.count, 0);
      expect(total).toBe(5);
    });
  });

  // ── Empty scores ──────────────────────────────────────────────────────────
  describe("empty scores", () => {
    test("returns empty array", () => {
      expect(buildDistribution([], 100)).toEqual([]);
    });
  });

  // ── null scores ───────────────────────────────────────────────────────────
  describe("null scores", () => {
    test("returns empty array", () => {
      expect(buildDistribution(null, 100)).toEqual([]);
    });
  });

  // ── Score at exact boundary (100 out of 100) ──────────────────────────────
  describe("perfect score [100] out of 100 — clamped to last bucket", () => {
    const dist = buildDistribution([100], 100);

    test("score 100 falls in last bucket (90–100)", () => {
      // floor(100/100 * 10) = 10 → clamped to index 9
      expect(dist[9].count).toBe(1);
      // all other buckets empty
      for (let i = 0; i < 9; i++) {
        expect(dist[i].count).toBe(0);
      }
    });
  });

  // ── Score of zero ─────────────────────────────────────────────────────────
  describe("zero score [0] out of 100", () => {
    const dist = buildDistribution([0], 100);

    test("score 0 falls in first bucket (0–10)", () => {
      // floor(0/100 * 10) = 0
      expect(dist[0].count).toBe(1);
    });
  });

  // ── Non-100 totalMarks ────────────────────────────────────────────────────
  describe("scores [5, 15, 25] out of 30", () => {
    const dist = buildDistribution([5, 15, 25], 30);

    // bucketSize = 30/10 = 3
    // Bucket 0: 0–3,   Bucket 1: 3–6,   Bucket 2: 6–9,   Bucket 3: 9–12,
    // Bucket 4: 12–15, Bucket 5: 15–18, Bucket 6: 18–21, Bucket 7: 21–24,
    // Bucket 8: 24–27, Bucket 9: 27–30
    //
    // score 5:  floor(5/30*10)  = floor(1.667) = 1 → bucket 1 (3–6)
    // score 15: floor(15/30*10) = floor(5)     = 5 → bucket 5 (15–18)
    // score 25: floor(25/30*10) = floor(8.33)  = 8 → bucket 8 (24–27)
    test("bucket labels for totalMarks=30", () => {
      const expected = ["0–3", "3–6", "6–9", "9–12", "12–15",
                        "15–18", "18–21", "21–24", "24–27", "27–30"];
      expect(dist.map(b => b.label)).toEqual(expected);
    });

    test("scores land in correct buckets", () => {
      const counts = dist.map(b => b.count);
      //                0  1  2  3  4  5  6  7  8  9
      expect(counts).toEqual([0, 1, 0, 0, 0, 1, 0, 0, 1, 0]);
    });
  });

  // ── Multiple scores in same bucket ────────────────────────────────────────
  describe("multiple scores in same bucket [55, 58, 59] out of 100", () => {
    const dist = buildDistribution([55, 58, 59], 100);

    test("all three scores fall in bucket 5 (50–60)", () => {
      expect(dist[5].count).toBe(3);
      // all others zero
      for (let i = 0; i < 10; i++) {
        if (i !== 5) expect(dist[i].count).toBe(0);
      }
    });
  });

  // ── Negative score (edge case — should clamp to bucket 0) ─────────────────
  describe("negative score [-5] out of 100 — clamped to first bucket", () => {
    const dist = buildDistribution([-5], 100);

    test("negative score clamped to bucket 0", () => {
      // floor(-5/100 * 10) = floor(-0.5) = -1 → clamped to 0
      expect(dist[0].count).toBe(1);
    });
  });
});
