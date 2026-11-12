const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const { getFinanceReportService, resolveReportRange } = require("./financeReport.service");
const { todayKey } = require("../../utils/dateRange");

// ---- Finance trend charts (Phase 4 visual layer — admin only, READ-ONLY) ----
//
// PURE COMPOSITION: every point below is produced by the SAME
// getFinanceReportService the report pages and /api/v1/finance-report use.
// No aggregation, rounding or date math is re-implemented here — the yearly
// trend is literally twelve monthly reports, and the daily sparkline is the
// month's daily reports, so a chart point can never disagree with the table
// or the export for the same period.
//
// Fail-soft per point: one failed month/day yields nulls for that point only
// (the chart skips it); the caller still renders the tabular report. Range
// validation is delegated to resolveReportRange (fail-closed, same rules as
// the report picker).

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Bound concurrent report calls so a trend never floods the connection pool:
// each report itself fans out into parallel reads (net-summary core + head
// breakdowns + finalized salaries).
const CHUNK_SIZE = 6;

const NULL_POINT = { ok: false, collections: null, income: null, expenses: null, salaries: null, net: null };

// One report call through the shared capture adapter — returns the report
// data, or null when the service responded with a failure envelope OR threw
// (a transient DB hiccup nulls one point, never the whole trend).
async function reportFor(query) {
  try {
    const { res, result } = captureServiceResponse();
    await getFinanceReportService(query, res);
    return result.ok ? result.body.data : null;
  } catch (_) {
    return null;
  }
}

function pointOf(report) {
  if (!report) return { ...NULL_POINT };
  return {
    ok: true,
    collections: report.collections,
    income: report.income,
    expenses: report.expenses,
    salaries: report.salaries,
    net: report.net,
  };
}

// Run reportFor over a list of queries in bounded-parallel chunks, preserving
// input order in the returned array.
async function pointsFor(queries) {
  const points = new Array(queries.length);
  for (let i = 0; i < queries.length; i += CHUNK_SIZE) {
    const batch = queries.slice(i, i + CHUNK_SIZE);
    const reports = await Promise.all(batch.map((q) => reportFor(q)));
    reports.forEach((report, j) => {
      points[i + j] = pointOf(report);
    });
  }
  return points;
}

/**
 * Monthly trend across a year: 12 points (Jan–Dec), each the existing monthly
 * report for that month. Returns { year, months: [{ month, label, ok,
 * collections, income, expenses, salaries, net }] } or { error }.
 */
exports.getMonthlyTrend = async (year) => {
  const range = resolveReportRange({ mode: "yearly", year });
  if (range.error) return { error: range.error };

  const queries = MONTH_LABELS.map((_, i) => ({
    mode: "monthly",
    month: `${year}-${String(i + 1).padStart(2, "0")}`,
  }));
  const points = await pointsFor(queries);

  return {
    year,
    months: points.map((p, i) => ({ month: queries[i].month, label: MONTH_LABELS[i], ...p })),
  };
};

/**
 * Daily trend within a month: one point per calendar day, each the existing
 * daily report. Days after today are marked future:true with null totals and
 * are NEVER queried (no money can exist yet); the chart draws them as gaps.
 * Returns { month, days: [{ date, day, ok, future?, collections, income,
 * expenses, salaries, net }] } or { error }.
 */
exports.getDailyTrend = async (month) => {
  const range = resolveReportRange({ mode: "monthly", month });
  if (range.error) return { error: range.error };

  const today = todayKey();
  const lastDay = Number(range.to.slice(8, 10));

  const days = [];
  const queries = [];
  const queryIdx = [];
  for (let d = 1; d <= lastDay; d += 1) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    if (date > today) {
      days.push({ date, day: d, future: true, ...NULL_POINT, ok: true });
    } else {
      days.push(null); // filled below, keeps day order
      queries.push({ mode: "daily", date });
      queryIdx.push(d - 1);
    }
  }

  const points = await pointsFor(queries);
  points.forEach((p, i) => {
    days[queryIdx[i]] = { date: queries[i].date, day: queryIdx[i] + 1, ...p };
  });

  return { month, days };
};