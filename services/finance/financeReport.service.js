const responseStatus = require("../../handlers/responseStatus.handler");
const IncomeEntry = require("../../models/Income/incomeEntry.model");
const IncomeHead = require("../../models/Income/incomeHead.model");
const ExpenseEntry = require("../../models/Expenses/expenseEntry.model");
const ExpenseHead = require("../../models/Expenses/expenseHead.model");
const TeacherSalaryRun = require("../../models/Staff/teacherSalaryRun.model");
const { round2, parseDayStart } = require("../../utils/teacherSalaryCalc");
const { dayRangeFilter } = require("../../utils/dateRange");
const { computeNetSummary } = require("./netSummary.service");

// ---- Phase 4 financial reporting (admin only, READ-ONLY) ----
//
// Daily / Monthly / Yearly reports composing the SAME collections/income/
// expenses totals as GET /net-summary (computeNetSummary — one shared query
// path, never a re-implementation) plus:
//   • income / expenses broken down by head (group-by-head aggregates),
//   • salaries PAID in the period = finalized salary runs whose finalizedAt
//     falls in the range (drafts are never money paid; the run's pay period
//     may differ from its finalize date — the report follows the money).
//
// Net = collections + income − expenses − salaries (Admin-confirmed: salaries
// are a real expense and fold into the headline figure). netBeforeSalaries is
// also returned — it always equals /net-summary's net for the same range.
//
// Every range resolves to a from/to pair of YYYY-MM-DD keys and flows through
// the shared utils/dateRange helper — the SAME inclusive local-calendar-day
// bounds as the collections fix. Monthly/yearly are just wider daily ranges;
// there is no second date-handling path. No underlying collection/expense/
// income/salary logic is touched — this service only reads and aggregates.

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

/**
 * mode + picker value → { mode, from, to } YYYY-MM-DD keys, or { error }.
 * Fail-closed: anything missing/malformed is a 400 before any query runs.
 */
function resolveReportRange(query = {}) {
  const mode = query.mode;

  if (mode === "daily") {
    if (!query.date) return { error: "A date is required for the daily report — expected YYYY-MM-DD" };
    if (!parseDayStart(query.date)) return { error: "Invalid date — expected YYYY-MM-DD" };
    return { mode, from: query.date, to: query.date };
  }

  if (mode === "monthly") {
    if (!query.month) return { error: "A month is required for the monthly report — expected YYYY-MM" };
    if (!MONTH_RE.test(query.month) || !parseDayStart(`${query.month}-01`)) {
      return { error: "Invalid month — expected YYYY-MM" };
    }
    const [y, m] = query.month.split("-").map(Number);
    // Last calendar day of the month (local) — Feb handles leap years.
    const lastDay = new Date(y, m, 0).getDate();
    return { mode, from: `${query.month}-01`, to: `${query.month}-${String(lastDay).padStart(2, "0")}` };
  }

  if (mode === "yearly") {
    if (!query.year) return { error: "A year is required for the yearly report — expected YYYY" };
    if (!YEAR_RE.test(query.year) || !parseDayStart(`${query.year}-01-01`)) {
      return { error: "Invalid year — expected YYYY" };
    }
    return { mode, from: `${query.year}-01-01`, to: `${query.year}-12-31` };
  }

  return { error: "mode must be daily, monthly or yearly" };
}

// Group entries by head over the shared local bounds, then resolve head names
// in ONE follow-up find (no per-row lookup). Deactivated heads keep their
// historical totals — deactivation never erases money already recorded.
async function headBreakdown(EntryModel, HeadModel, headField, bounds) {
  const groups = await EntryModel.aggregate([
    { $match: { date: bounds } },
    { $group: { _id: `$${headField}`, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);
  if (groups.length === 0) return [];

  const ids = groups.map((g) => g._id).filter(Boolean);
  const heads = ids.length
    ? await HeadModel.find({ _id: { $in: ids } }).select("name isActive").lean()
    : [];
  const byId = new Map(heads.map((h) => [String(h._id), h]));

  return groups.map((g) => {
    const head = g._id ? byId.get(String(g._id)) : null;
    return {
      headId: g._id || null,
      name: head ? head.name : "Unknown head",
      isActive: head ? !!head.isActive : false,
      total: round2(g.total),
      count: g.count,
    };
  });
}

// Salaries paid in the period: FINALIZED runs whose finalizedAt instant falls
// inside the shared local bounds. netAmount (after late deductions) is the
// payable figure. Runs are grouped per teacher for the summary table; the raw
// run list keeps the full audit trail (period + finalize date per run).
async function salariesPaid(bounds) {
  const runs = await TeacherSalaryRun.find({ status: "finalized", finalizedAt: bounds })
    .populate({ path: "teacher", select: "name teacherId" })
    .sort({ finalizedAt: 1 })
    .lean();

  const byTeacher = new Map();
  const rows = runs.map((run) => {
    const teacher = run.teacher || {};
    const key = teacher._id ? String(teacher._id) : "unknown";
    const name = teacher.name || "Unknown teacher";
    const entry = byTeacher.get(key) || {
      teacherId: teacher._id || null,
      name,
      staffId: teacher.teacherId || "",
      runs: 0,
      total: 0,
    };
    entry.runs += 1;
    entry.total = round2(entry.total + (run.netAmount || 0));
    byTeacher.set(key, entry);

    return {
      runId: run._id,
      teacherName: name,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      netAmount: round2(run.netAmount || 0),
      finalizedAt: run.finalizedAt,
    };
  });

  const teacherRows = [...byTeacher.values()].sort((a, b) => b.total - a.total);
  const total = round2(teacherRows.reduce((s, t) => s + t.total, 0));
  return { runs: rows, byTeacher: teacherRows, total };
}

exports.resolveReportRange = resolveReportRange;

exports.getFinanceReportService = async (query = {}, res) => {
  const range = resolveReportRange(query);
  if (range.error) return responseStatus(res, 400, "failed", range.error);

  const { mode, from, to } = range;
  const bounds = dayRangeFilter(from, to);

  // Compose the shared net-summary core with the report-only breakdowns —
  // all independent reads, fetched in parallel.
  const [summary, incomeByHead, expensesByHead, salary] = await Promise.all([
    computeNetSummary(from, to),
    headBreakdown(IncomeEntry, IncomeHead, "incomeHead", bounds),
    headBreakdown(ExpenseEntry, ExpenseHead, "expenseHead", bounds),
    salariesPaid(bounds),
  ]);

  const net = round2(summary.collections + summary.income - summary.expenses - salary.total);

  return responseStatus(res, 200, "success", {
    mode,
    from,
    to,
    collections: summary.collections,
    income: summary.income,
    expenses: summary.expenses,
    salaries: salary.total,
    netBeforeSalaries: summary.net,
    net,
    counts: { ...summary.counts, salaries: salary.runs.length },
    incomeByHead,
    expensesByHead,
    salaryByTeacher: salary.byTeacher,
    salaryRuns: salary.runs,
  });
};
