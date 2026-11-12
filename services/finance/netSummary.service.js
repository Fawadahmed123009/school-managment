const responseStatus = require("../../handlers/responseStatus.handler");
const Fees = require("../../models/Fees/fees.model");
const IncomeEntry = require("../../models/Income/incomeEntry.model");
const ExpenseEntry = require("../../models/Expenses/expenseEntry.model");
const { round2 } = require("../../utils/teacherSalaryCalc");
const { dayRangeFilter, parseDayStart } = require("../../utils/dateRange");

// ---- Net profit/loss building block (admin only) ----
//
// Net = Fee Collections + ad-hoc Income − Expenses, over an inclusive
// local-calendar date range. This is the single endpoint Phase 4 daily/monthly/
// yearly reports consume; it ONLY reads — no existing collections/expense logic
// is altered.
//
// Collections mirrors getDailyCollectionData's effective query exactly: paid
// fees whose datePaid falls in the range, excluding soft-deleted records. The
// isDeleted scope is stated explicitly here (the Fees model's aggregate hook
// would add the same guard) so the rule is visible and refactor-proof. All three
// totals use the shared utils/dateRange bounds — never hand-rolled UTC midnights
// (which undercount final-day and early-PKT payments).
//
// Both from and to are REQUIRED (fail-closed): an explicit range avoids an
// accidental all-time scan and gives Phase 4 an unambiguous contract.
const sumPipeline = (match, amountField) => [
  { $match: match },
  { $group: { _id: null, total: { $sum: amountField }, count: { $sum: 1 } } },
];

const totalOf = (agg) => round2(agg && agg[0] ? agg[0].total : 0);
const countOf = (agg) => (agg && agg[0] ? agg[0].count : 0);

/**
 * Shared read-only core — the exact collections/income/expenses totals behind
 * GET /net-summary, reused by the Phase 4 daily/monthly/yearly reports
 * (services/finance/financeReport.service.js) so there is ONE query path for
 * the three totals. Caller validates from/to first (fail-closed); bounds come
 * from the shared utils/dateRange helper. Returns totals + counts only — no
 * response is written here.
 */
async function computeNetSummary(fromKey, toKey) {
  const bounds = dayRangeFilter(fromKey, toKey);

  // Three independent totals — fetch in parallel (no N+1, no row hydration).
  const [feeAgg, incomeAgg, expenseAgg] = await Promise.all([
    Fees.aggregate(sumPipeline({ status: "paid", isDeleted: { $ne: true }, datePaid: bounds }, "$amount")),
    IncomeEntry.aggregate(sumPipeline({ date: bounds }, "$totalAmount")),
    ExpenseEntry.aggregate(sumPipeline({ date: bounds }, "$totalAmount")),
  ]);

  const collections = totalOf(feeAgg);
  const income = totalOf(incomeAgg);
  const expenses = totalOf(expenseAgg);

  return {
    collections,
    income,
    expenses,
    net: round2(collections + income - expenses),
    counts: {
      collections: countOf(feeAgg),
      income: countOf(incomeAgg),
      expenses: countOf(expenseAgg),
    },
  };
}

exports.computeNetSummary = computeNetSummary;

exports.getNetSummaryService = async (query = {}, res) => {
  const from = query.from ? parseDayStart(query.from) : null;
  const to = query.to ? parseDayStart(query.to) : null;

  if (!query.from || !query.to) {
    return responseStatus(res, 400, "failed", "Both from and to dates are required — expected YYYY-MM-DD");
  }
  if (!from) return responseStatus(res, 400, "failed", "Invalid from date — expected YYYY-MM-DD");
  if (!to) return responseStatus(res, 400, "failed", "Invalid to date — expected YYYY-MM-DD");
  if (from > to) return responseStatus(res, 400, "failed", "From date must not be after to date");

  const summary = await computeNetSummary(query.from, query.to);

  // Envelope unchanged: net here stays collections + income − expenses (the
  // live building-block contract). Phase 4 reports fold salaries into THEIR
  // net figure on top of this core — this endpoint's number never shifts.
  return responseStatus(res, 200, "success", {
    from: query.from,
    to: query.to,
    ...summary,
  });
};
