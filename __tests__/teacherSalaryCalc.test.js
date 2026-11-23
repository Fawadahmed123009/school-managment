/**
 * Salary calculation engine tests (Phase 2) — pure utils/teacherSalaryCalc.js:
 * - Inclusive custom ranges ("4th to 4th" covers exactly one day).
 * - Rate history: segments split at effectiveFrom boundaries; the rate
 *   effective during each segment is used, never the current rate.
 * - Fail-closed: no config covering the period start → error, never Rs 0.
 * - Per-hour vs per-lecture; lecture override apportioned across segments.
 * - Lump sum: the configured AMOUNT is the pay for the period — attendance and
 *   lecture overrides are ignored; only a mid-period amount change splits it.
 * - Deductions: flat / percent, gated by BOTH settings, capped at gross.
 */

const {
  parseDayStart,
  inclusiveDays,
  payTypeLabel,
  buildRateSegments,
  computeLateDeduction,
  computeSalary,
} = require("../utils/teacherSalaryCalc");

const day = (s) => parseDayStart(s);
const cfg = (effectiveFrom, rateAmount, payType = "per-hour") => ({
  effectiveFrom: day(effectiveFrom),
  rateAmount,
  payType,
});
const rec = (date, workingMinutes, isLate = false, departureTime = "16:00") => ({
  date: day(date),
  arrivalTime: "08:00",
  departureTime,
  workingMinutes,
  isLate,
});

const SALARY_ON_FLAT = { lateDeductionEnabled: true, deductionType: "flat", flatAmount: 200, percentValue: 0 };
const SALARY_ON_PCT = { lateDeductionEnabled: true, deductionType: "percent", flatAmount: 0, percentValue: 10 };
const SALARY_OFF = { lateDeductionEnabled: false, deductionType: "flat", flatAmount: 200, percentValue: 0 };
const PHASE1_ON = { lateDetectionEnabled: true };
const PHASE1_OFF = { lateDetectionEnabled: false };

describe("parseDayStart", () => {
  it("parses a real calendar day at local midnight", () => {
    const d = parseDayStart("2026-11-04");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(4);
    expect(d.getHours()).toBe(0);
  });

  it.each(["2026-13-01", "2026-02-30", "4-11-2026", "", null, "2026-11-04T00:00"])("%p → null", (v) => {
    expect(parseDayStart(v)).toBeNull();
  });
});

describe("buildRateSegments — rate history resolution", () => {
  it("one config covering the range → a single segment", () => {
    const built = buildRateSegments([cfg("2026-10-01", 500)], day("2026-11-04"), day("2026-12-04"));
    expect(built.error).toBeUndefined();
    expect(built.payType).toBe("per-hour");
    expect(built.segments).toHaveLength(1);
    expect(built.segments[0].rateAmount).toBe(500);
    expect(built.segments[0].start).toEqual(day("2026-11-04"));
    expect(built.segments[0].end).toEqual(day("2026-12-04"));
  });

  it("mid-period rate change → one segment per effective rate", () => {
    const built = buildRateSegments(
      [cfg("2026-10-01", 500), cfg("2026-11-15", 600)],
      day("2026-11-04"),
      day("2026-12-04")
    );
    expect(built.segments).toHaveLength(2);
    expect(built.segments[0]).toMatchObject({ rateAmount: 500, start: day("2026-11-04"), end: day("2026-11-14") });
    expect(built.segments[1]).toMatchObject({ rateAmount: 600, start: day("2026-11-15"), end: day("2026-12-04") });
  });

  it("uses the NEWEST config effective on/before the start (history, not current)", () => {
    const built = buildRateSegments(
      [cfg("2026-01-01", 300), cfg("2026-06-01", 400), cfg("2027-01-01", 900)],
      day("2026-11-04"),
      day("2026-11-04")
    );
    expect(built.segments).toHaveLength(1);
    expect(built.segments[0].rateAmount).toBe(400); // the future 900 row is ignored
  });

  it("no config covering the period start → fail-closed error", () => {
    const built = buildRateSegments([cfg("2026-11-10", 500)], day("2026-11-04"), day("2026-11-08"));
    expect(built.error).toMatch(/No pay config effective/);
  });

  it("empty history → fail-closed error", () => {
    expect(buildRateSegments([], day("2026-11-04"), day("2026-11-04")).error).toBeTruthy();
  });

  it("pay TYPE change inside the period → error (separate runs required)", () => {
    const built = buildRateSegments(
      [cfg("2026-10-01", 500, "per-hour"), cfg("2026-11-15", 700, "per-lecture")],
      day("2026-11-04"),
      day("2026-12-04")
    );
    expect(built.error).toMatch(/Pay type changes/);
  });
});

describe("computeSalary — per-hour", () => {
  it("custom '4th to 4th' range: only that day's record is paid", () => {
    // The service queries the exact range; the engine buckets what it gets.
    const out = computeSalary({
      records: [rec("2026-11-04", 480)],
      configs: [cfg("2026-10-01", 500)],
      start: day("2026-11-04"),
      end: day("2026-11-04"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.totalWorkingDays).toBe(1);
    expect(out.totalWorkingHours).toBe(8);
    expect(out.grossAmount).toBe(4000); // 8h × 500
    expect(out.netAmount).toBe(4000);
    expect(out.days).toHaveLength(1);
  });

  it("mid-period rate change pays each segment at its own rate", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480), rec("2026-11-16", 480)],
      configs: [cfg("2026-10-01", 500), cfg("2026-11-15", 600)],
      start: day("2026-11-04"),
      end: day("2026-12-04"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]).toMatchObject({ days: 1, hours: 8, amount: 4000 });
    expect(out.segments[1]).toMatchObject({ days: 1, hours: 8, amount: 4800 });
    expect(out.grossAmount).toBe(8800);
  });

  it("rounds money to 2 decimals (fractional hours)", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 455)], // 7h35m
      configs: [cfg("2026-10-01", 333)],
      start: day("2026-11-04"),
      end: day("2026-11-04"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.totalWorkingHours).toBe(7.58);
    expect(out.grossAmount).toBe(2525.25); // (455/60) × 333
  });

  it("arrival-only day counts as a working day with 0 hours and is flagged incomplete", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 0, false, "")],
      configs: [cfg("2026-10-01", 500)],
      start: day("2026-11-04"),
      end: day("2026-11-04"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.totalWorkingDays).toBe(1);
    expect(out.incompleteDays).toBe(1);
    expect(out.grossAmount).toBe(0);
  });

  it("no config covering the period → error, never a silent zero run", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480)],
      configs: [cfg("2026-11-10", 500)],
      start: day("2026-11-04"),
      end: day("2026-11-04"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.error).toMatch(/No pay config effective/);
  });
});

describe("computeSalary — per-lecture", () => {
  const lectureCfg = [cfg("2026-10-01", 700, "per-lecture")];

  it("default lecture count = attended days", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480), rec("2026-11-05", 480), rec("2026-11-06", 480)],
      configs: lectureCfg,
      start: day("2026-11-04"),
      end: day("2026-11-06"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.lectureCountDefault).toBe(3);
    expect(out.lectureCount).toBe(3);
    expect(out.lectureOverridden).toBe(false);
    expect(out.grossAmount).toBe(2100); // 3 × 700
  });

  it("admin override replaces the default and is flagged", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480), rec("2026-11-05", 480)],
      configs: lectureCfg,
      start: day("2026-11-04"),
      end: day("2026-11-05"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
      lectureOverride: 10,
    });
    expect(out.lectureCountDefault).toBe(2);
    expect(out.lectureCount).toBe(10);
    expect(out.lectureOverridden).toBe(true);
    expect(out.grossAmount).toBe(7000);
  });

  it("override is apportioned across rate segments by attended days", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480), rec("2026-11-16", 480), rec("2026-11-17", 480)],
      configs: [cfg("2026-10-01", 700, "per-lecture"), cfg("2026-11-15", 800, "per-lecture")],
      start: day("2026-11-04"),
      end: day("2026-11-17"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
      lectureOverride: 9,
    });
    // 1 day at 700, 2 days at 800 → 3 and 6 lectures
    expect(out.segments[0]).toMatchObject({ days: 1, lectures: 3, amount: 2100 });
    expect(out.segments[1]).toMatchObject({ days: 2, lectures: 6, amount: 4800 });
    expect(out.grossAmount).toBe(6900);
  });

  it("override with NO attendance bills at the latest effective rate", () => {
    const out = computeSalary({
      records: [],
      configs: [cfg("2026-10-01", 700, "per-lecture"), cfg("2026-11-15", 800, "per-lecture")],
      start: day("2026-11-04"),
      end: day("2026-11-17"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
      lectureOverride: 4,
    });
    expect(out.totalWorkingDays).toBe(0);
    expect(out.segments[0].lectures).toBe(0);
    expect(out.segments[1].lectures).toBe(4);
    expect(out.grossAmount).toBe(3200);
  });

  it("override is ignored for per-hour teachers", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480)],
      configs: [cfg("2026-10-01", 500)],
      start: day("2026-11-04"),
      end: day("2026-11-04"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
      lectureOverride: 99,
    });
    expect(out.lectureOverridden).toBe(false);
    expect(out.grossAmount).toBe(4000);
  });
});

describe("computeLateDeduction — gating and modes", () => {
  const base = { gross: 10000, lateDays: 2, workingDays: 10 };

  it("flat: lateDays × flatAmount", () => {
    expect(computeLateDeduction({ ...base, salarySettings: SALARY_ON_FLAT, phase1Settings: PHASE1_ON })).toBe(400);
  });

  it("percent: % of the late-day share of gross", () => {
    // 10% × (10000 × 2/10) = 200
    expect(computeLateDeduction({ ...base, salarySettings: SALARY_ON_PCT, phase1Settings: PHASE1_ON })).toBe(200);
  });

  it("salary rule disabled → no deduction", () => {
    expect(computeLateDeduction({ ...base, salarySettings: SALARY_OFF, phase1Settings: PHASE1_ON })).toBe(0);
  });

  it("Phase 1 detection disabled → no deduction even with the salary rule on", () => {
    expect(computeLateDeduction({ ...base, salarySettings: SALARY_ON_FLAT, phase1Settings: PHASE1_OFF })).toBe(0);
  });

  it("no late days → no deduction", () => {
    expect(computeLateDeduction({ ...base, lateDays: 0, salarySettings: SALARY_ON_FLAT, phase1Settings: PHASE1_ON })).toBe(0);
  });

  it("flat deduction larger than gross is capped at gross (net never negative)", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 60, true)],
      configs: [cfg("2026-10-01", 100)],
      start: day("2026-11-04"),
      end: day("2026-11-04"),
      salarySettings: { lateDeductionEnabled: true, deductionType: "flat", flatAmount: 5000 },
      phase1Settings: PHASE1_ON,
    });
    expect(out.grossAmount).toBe(100); // 1h × 100
    expect(out.lateDeductionAmount).toBe(100);
    expect(out.netAmount).toBe(0);
  });

  it("percent deduction is capped at gross", () => {
    expect(computeLateDeduction({
      gross: 1000, lateDays: 10, workingDays: 10,
      salarySettings: { lateDeductionEnabled: true, deductionType: "percent", percentValue: 100 },
      phase1Settings: PHASE1_ON,
    })).toBe(1000);
  });
});

describe("computeSalary — end-to-end deduction snapshot", () => {
  it("stores the rule snapshot and derives net = gross − deduction", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480, true), rec("2026-11-05", 480, false)],
      configs: [cfg("2026-10-01", 500)],
      start: day("2026-11-04"),
      end: day("2026-11-05"),
      salarySettings: SALARY_ON_FLAT,
      phase1Settings: PHASE1_ON,
    });
    expect(out.lateDays).toBe(1);
    expect(out.grossAmount).toBe(8000);
    expect(out.lateDeductionAmount).toBe(200);
    expect(out.netAmount).toBe(7800);
    expect(out.deductionRule).toEqual({ enabled: true, type: "flat", value: 200 });
  });

  it("detection off → snapshot keeps the configured rule but deducts nothing", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480, false)],
      configs: [cfg("2026-10-01", 500)],
      start: day("2026-11-04"),
      end: day("2026-11-04"),
      salarySettings: SALARY_ON_FLAT,
      phase1Settings: PHASE1_OFF,
    });
    expect(out.lateDeductionAmount).toBe(0);
    expect(out.netAmount).toBe(4000);
    expect(out.deductionRule.enabled).toBe(true);
  });
});

/* ── lump sum (third pay mode) ──────────────────────────────────────────────
 * rateAmount IS the period's pay: no rate × units, no attendance input, no
 * lecture override. Attendance is still REPORTED next to the amount, and the
 * only thing that can split the amount is a mid-period AMOUNT change.
 */
describe("computeSalary — lump sum", () => {
  const lumpCfg = [cfg("2026-10-01", 30000, "lump-sum")];
  const month = { start: day("2026-11-01"), end: day("2026-11-30") };

  it("pays the configured amount for the period", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480), rec("2026-11-05", 480)],
      configs: lumpCfg,
      ...month,
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.payType).toBe("lump-sum");
    expect(out.grossAmount).toBe(30000);
    expect(out.netAmount).toBe(30000);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]).toMatchObject({ rateAmount: 30000, periodDays: 30, amount: 30000 });
  });

  it("attendance changes nothing — full month, one day and no days all pay the same", () => {
    const forRecords = (records) =>
      computeSalary({
        records,
        configs: lumpCfg,
        ...month,
        salarySettings: SALARY_OFF,
        phase1Settings: PHASE1_ON,
      });
    const full = forRecords([
      rec("2026-11-04", 480), rec("2026-11-05", 480), rec("2026-11-06", 480),
    ]);
    const one = forRecords([rec("2026-11-04", 480)]);
    const none = forRecords([]);
    expect(full.grossAmount).toBe(30000);
    expect(one.grossAmount).toBe(30000);
    expect(none.grossAmount).toBe(30000);
    // …but attendance is still reported alongside the amount, never hidden.
    expect(full.totalWorkingDays).toBe(3);
    expect(full.totalWorkingHours).toBe(24);
    expect(none.totalWorkingDays).toBe(0);
  });

  it("a lecture override is ignored (lump sum has no units to override)", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480)],
      configs: lumpCfg,
      ...month,
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
      lectureOverride: 40,
    });
    expect(out.lectureCount).toBe(0);
    expect(out.lectureOverridden).toBe(false);
    expect(out.grossAmount).toBe(30000);
  });

  it("a single-day period pays the amount in full (the amount is per period)", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480)],
      configs: lumpCfg,
      start: day("2026-11-04"),
      end: day("2026-11-04"),
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.segments[0]).toMatchObject({ periodDays: 1, amount: 30000 });
    expect(out.grossAmount).toBe(30000);
  });

  it("mid-period AMOUNT change splits by calendar days so each part is paid its own amount", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480), rec("2026-11-20", 480)],
      configs: [cfg("2026-11-01", 30000, "lump-sum"), cfg("2026-11-16", 35000, "lump-sum")],
      ...month,
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.segments).toHaveLength(2);
    // Nov 1–15 at 30 000 and Nov 16–30 at 35 000 over a 30-day period.
    expect(out.segments[0]).toMatchObject({ rateAmount: 30000, periodDays: 15, amount: 15000 });
    expect(out.segments[1]).toMatchObject({ rateAmount: 35000, periodDays: 15, amount: 17500 });
    expect(out.grossAmount).toBe(32500);
  });

  it("late deduction still applies on top of the lump gross", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480, true), rec("2026-11-05", 480, true), rec("2026-11-06", 480, false)],
      configs: lumpCfg,
      ...month,
      salarySettings: SALARY_ON_FLAT,
      phase1Settings: PHASE1_ON,
    });
    expect(out.lateDays).toBe(2);
    expect(out.grossAmount).toBe(30000);
    expect(out.lateDeductionAmount).toBe(400); // 2 late days × Rs 200
    expect(out.netAmount).toBe(29600);
  });

  it("pay TYPE change across a lump boundary still fails closed", () => {
    const out = computeSalary({
      records: [rec("2026-11-04", 480)],
      configs: [cfg("2026-10-01", 30000, "lump-sum"), cfg("2026-11-15", 700, "per-lecture")],
      ...month,
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.error).toMatch(/Pay type changes/);
  });

  it("no lump config covering the period start → error, never a silent Rs 0", () => {
    const out = computeSalary({
      records: [],
      configs: [cfg("2026-11-10", 30000, "lump-sum")],
      ...month,
      salarySettings: SALARY_OFF,
      phase1Settings: PHASE1_ON,
    });
    expect(out.error).toMatch(/No pay config effective/);
  });
});

describe("payTypeLabel — one label source for config table, run detail and preview", () => {
  it.each([
    ["per-hour", "Per hour"],
    ["per-lecture", "Per lecture"],
    ["lump-sum", "Lump sum"],
  ])("%s → %s", (payType, label) => {
    expect(payTypeLabel(payType)).toBe(label);
  });

  it.each([["monthly"], ["per-day"], [""], [null], [undefined]])("%p → em dash, never a silent fallback", (payType) => {
    expect(payTypeLabel(payType)).toBe("—");
  });
});

describe("inclusiveDays", () => {
  it.each([
    ["2026-11-04", "2026-11-04", 1],
    ["2026-11-01", "2026-11-30", 30],
    ["2026-11-16", "2026-11-30", 15],
    ["2026-12-31", "2027-01-01", 2],
    ["2028-02-01", "2028-02-29", 29], // leap year
  ])("%p → %p = %i day(s)", (start, end, expected) => {
    expect(inclusiveDays(day(start), day(end))).toBe(expected);
  });

  it("clamps a reversed range to 1 instead of going negative", () => {
    expect(inclusiveDays(day("2026-11-30"), day("2026-11-01"))).toBe(1);
  });
});