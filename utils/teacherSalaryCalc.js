/**
 * Pure salary calculation helpers for teacher salary — Phase 2.
 *
 * No DB, no res — keeping the math here makes it unit-testable and gives the
 * salary service (preview AND generate) one source of truth, mirroring the
 * Phase 1 utils/teacherAttendanceTime.js pattern.
 *
 * Conventions inherited from Phase 1:
 *   • dates are server-LOCAL midnight; a period is INCLUSIVE on both ends
 *     (a "4th to 4th" run covers exactly that one day);
 *   • workingMinutes / isLate are the DERIVED values stored on each
 *     TeacherAttendance record — they are consumed as-is (Phase 1 already
 *     re-flags them whenever the late rule changes).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// "YYYY-MM-DD" → Date at server-LOCAL midnight, or null when malformed / not
// a real calendar day (same rule as the Phase 1 marking service).
function parseDayStart(dateStr) {
  if (typeof dateStr !== "string" || !DATE_RE.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  if (day.getFullYear() !== y || day.getMonth() !== m - 1 || day.getDate() !== d) return null;
  day.setHours(0, 0, 0, 0);
  return day;
}

const nextDay = (d) => {
  const n = new Date(d);
  n.setDate(n.getDate() + 1);
  return n;
};

/**
 * Split [start, end] (inclusive, local-midnight Dates) into rate-effective
 * segments from a teacher's INSERT-ONLY pay-config history.
 *
 * Each segment uses the newest config with effectiveFrom <= segment start.
 * Fail-closed rules:
 *   • no config covers `start`            → { error } (never a silent Rs 0);
 *   • pay TYPE changes inside the period  → { error } (a run has one pay
 *     type; the admin generates separate runs on each side of the change).
 *
 * Returns { payType, segments: [{ effectiveFrom, rateAmount, start, end }] }
 * where each segment's start/end are inclusive local-midnight Dates.
 */
function buildRateSegments(configs, start, end) {
  const sorted = [...(configs || [])].sort(
    (a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom)
  );

  // Newest row effective on (or before) the period start.
  let covering = null;
  for (const c of sorted) {
    if (new Date(c.effectiveFrom) <= start) covering = c;
  }
  if (!covering) {
    return { error: "No pay config effective for this period — set a rate with an effective-from date on or before the period start" };
  }

  // Every later config row that lands inside the period opens a new segment.
  const boundaries = sorted.filter((c) => {
    const eff = new Date(c.effectiveFrom);
    return eff > start && eff <= end;
  });
  for (const c of boundaries) {
    if (c.payType !== covering.payType) {
      return { error: "Pay type changes inside this period — generate separate runs for each pay type" };
    }
  }

  const segments = [];
  let segStart = start;
  let rate = covering;
  for (const c of boundaries) {
    const eff = new Date(c.effectiveFrom);
    const segEnd = new Date(eff);
    segEnd.setDate(segEnd.getDate() - 1);
    segments.push({ effectiveFrom: new Date(rate.effectiveFrom), rateAmount: rate.rateAmount, start: segStart, end: segEnd });
    segStart = eff;
    rate = c;
  }
  segments.push({ effectiveFrom: new Date(rate.effectiveFrom), rateAmount: rate.rateAmount, start: segStart, end });

  return { payType: covering.payType, segments };
}

/**
 * Late-arrival deduction for a run. Applies ONLY when the salary rule is
 * enabled AND Phase 1 late detection is enabled AND there are late days.
 *   flat    → lateDays × flatAmount
 *   percent → percentValue% of the gross attributable to late days
 *             (gross × lateDays / workingDays), capped at the gross.
 * Always rounded to 2 decimals and never negative / never above gross.
 */
function computeLateDeduction({ gross, lateDays, workingDays, salarySettings, phase1Settings }) {
  const s = salarySettings || {};
  const p1 = phase1Settings || {};
  if (!s.lateDeductionEnabled || !p1.lateDetectionEnabled || lateDays <= 0 || gross <= 0) {
    return 0;
  }
  let amount;
  if (s.deductionType === "percent") {
    const pct = Number(s.percentValue) || 0;
    amount = gross * (pct / 100) * (lateDays / Math.max(1, workingDays));
  } else {
    amount = lateDays * (Number(s.flatAmount) || 0);
  }
  return round2(Math.min(gross, Math.max(0, amount)));
}

/**
 * Full salary calculation for one teacher over one period.
 *
 * inputs:
 *   records        — Phase 1 attendance rows INSIDE the range (the service
 *                    queries them; each { date, arrivalTime, departureTime,
 *                    workingMinutes, isLate }).
 *   configs        — the teacher's whole pay-config history.
 *   start / end    — inclusive local-midnight Dates.
 *   salarySettings — Phase 2 deduction rule (singleton).
 *   phase1Settings — Phase 1 late rule (detection gate).
 *   lectureOverride— optional admin-entered lecture count (per-lecture only).
 *
 * Returns { error } on fail-closed conditions, otherwise the full run payload
 * (totals, rate segments, deduction snapshot, day-wise audit rows).
 */
function computeSalary({ records, configs, start, end, salarySettings, phase1Settings, lectureOverride }) {
  const built = buildRateSegments(configs, start, end);
  if (built.error) return { error: built.error };
  const { payType, segments } = built;

  const rows = [...(records || [])].sort((a, b) => new Date(a.date) - new Date(b.date));

  // Bucket each attendance day into its rate segment.
  const buckets = segments.map(() => []);
  for (const r of rows) {
    const d = new Date(r.date);
    const idx = segments.findIndex((s) => d >= s.start && d <= s.end);
    if (idx >= 0) buckets[idx].push(r);
  }

  const totalMinutes = rows.reduce((s, r) => s + (Number(r.workingMinutes) || 0), 0);
  const totalWorkingDays = rows.length;
  const lateDays = rows.filter((r) => r.isLate).length;
  const incompleteDays = rows.filter((r) => !r.departureTime).length;

  // Lecture accounting: default = attended days; an admin override replaces
  // it (per-lecture teachers only — ignored for per-hour).
  const lectureCountDefault = totalWorkingDays;
  const hasOverride =
    payType === "per-lecture" &&
    lectureOverride !== undefined && lectureOverride !== null && lectureOverride !== "" &&
    Number.isFinite(Number(lectureOverride)) && Number(lectureOverride) >= 0;
  const lectureCount = payType === "per-lecture"
    ? (hasOverride ? Math.floor(Number(lectureOverride)) : lectureCountDefault)
    : 0;

  const segPayloads = segments.map((seg, i) => {
    const bucket = buckets[i];
    const minutes = bucket.reduce((s, r) => s + (Number(r.workingMinutes) || 0), 0);
    const hours = round2(minutes / 60);
    let lectures = 0;
    let amount = 0;
    if (payType === "per-hour") {
      amount = round2((minutes / 60) * seg.rateAmount);
    } else {
      // Apportion the lecture count across rate segments proportionally to
      // each segment's attended days. With NO attended days at all, an
      // overridden count bills entirely at the latest effective rate.
      lectures = totalWorkingDays > 0
        ? round2((lectureCount * bucket.length) / totalWorkingDays)
        : (i === segments.length - 1 ? lectureCount : 0);
      amount = round2(lectures * seg.rateAmount);
    }
    return {
      effectiveFrom: seg.effectiveFrom,
      rateAmount: seg.rateAmount,
      days: bucket.length,
      hours,
      lectures,
      amount,
    };
  });

  const grossAmount = round2(segPayloads.reduce((s, x) => s + x.amount, 0));
  const lateDeductionAmount = computeLateDeduction({
    gross: grossAmount,
    lateDays,
    workingDays: totalWorkingDays,
    salarySettings,
    phase1Settings,
  });
  const netAmount = round2(Math.max(0, grossAmount - lateDeductionAmount));

  const s = salarySettings || {};
  return {
    payType,
    totalWorkingDays,
    totalWorkingHours: round2(totalMinutes / 60),
    lateDays,
    incompleteDays,
    lectureCountDefault,
    lectureCount,
    lectureOverridden: payType === "per-lecture" && hasOverride,
    segments: segPayloads,
    deductionRule: {
      enabled: !!s.lateDeductionEnabled,
      type: s.deductionType === "percent" ? "percent" : "flat",
      value: s.deductionType === "percent" ? (Number(s.percentValue) || 0) : (Number(s.flatAmount) || 0),
    },
    grossAmount,
    lateDeductionAmount,
    netAmount,
    days: rows.map((r) => ({
      date: new Date(r.date),
      arrivalTime: r.arrivalTime || "",
      departureTime: r.departureTime || "",
      workingMinutes: Number(r.workingMinutes) || 0,
      isLate: !!r.isLate,
    })),
  };
}

module.exports = {
  DATE_RE,
  round2,
  parseDayStart,
  buildRateSegments,
  computeLateDeduction,
  computeSalary,
};