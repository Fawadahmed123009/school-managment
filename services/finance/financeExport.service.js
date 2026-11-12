const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const { getFinanceReportService } = require("./financeReport.service");
const { getExpenseEntriesService } = require("../expenses/expenseEntry.service");
const { getIncomeEntriesService } = require("../income/incomeEntry.service");
const { localDateKey } = require("../../utils/localDateKey");

// ---- Finance export layer (admin only, READ-ONLY) ----
//
// CSV/Excel exports of the SAME data the report/history pages already show.
// This module never re-implements a calculation: it calls the existing
// services (financeReport / expenseEntry / incomeEntry) through the shared
// captureServiceResponse adapter and only reshapes their output into rows.
// Filters flow through unchanged, so an export always matches the applied
// on-screen view — never the full unfiltered dataset.

// paginate() caps limit at 100 — history exports walk every page of the
// filtered set (the on-screen running total already spans ALL filtered
// entries, so exporting only page 1 would contradict it).
const HISTORY_PAGE_LIMIT = 100;
// Fail-closed ceiling (50,000 entries): beyond it we refuse rather than
// silently truncate or loop unbounded.
const MAX_EXPORT_PAGES = 500;

// "csv" | "xlsx" | null — anything else is rejected before any query runs.
function normalizeExportFormat(raw) {
  const f = String(raw === undefined || raw === null ? "" : raw).trim().toLowerCase();
  return f === "csv" || f === "xlsx" ? f : null;
}

// ── Finance report (daily / monthly / yearly) ───────────────────────────────

async function fetchReportForExport(query) {
  try {
    const { res: cap, result } = captureServiceResponse();
    await getFinanceReportService(query, cap);
    if (!result.ok) return { ok: false, message: result.message || "Failed to load the report" };
    return { ok: true, report: result.body.data };
  } catch (err) {
    return { ok: false, message: err.message || "Failed to load the report" };
  }
}

const headLabel = (h) => h.name + (h.isActive ? "" : " (inactive)");

// One flat table, one row per line item — the CSV and the Excel sheet carry
// identical rows. Sections mirror the on-screen panels: headline totals,
// income by head, expenses by head, salaries by teacher, run detail.
function buildFinanceReportExport(report) {
  const period = report.from === report.to ? report.from : `${report.from} to ${report.to}`;
  const rows = [
    ["Section", "Item", "Detail", "Count", "Amount (Rs)"],
    ["Summary", "Collections (fees)", period, report.counts.collections, report.collections],
    ["Summary", "Ad-hoc income", period, report.counts.income, report.income],
    ["Summary", "Expenses", period, report.counts.expenses, report.expenses],
    ["Summary", "Salaries paid (finalized runs)", period, report.counts.salaries, report.salaries],
    ["Summary", "Net before salaries", "", "", report.netBeforeSalaries],
    ["Summary", report.net >= 0 ? "Net profit" : "Net loss", "", "", report.net],
  ];
  const netRowIdx = rows.length - 1;

  report.incomeByHead.forEach((h) => {
    rows.push(["Income by head", headLabel(h), "", h.count, h.total]);
  });
  report.expensesByHead.forEach((h) => {
    rows.push(["Expenses by head", headLabel(h), "", h.count, h.total]);
  });
  report.salaryByTeacher.forEach((t) => {
    rows.push(["Salaries by teacher", t.name + (t.staffId ? ` (${t.staffId})` : ""), "", t.runs, t.total]);
  });
  report.salaryRuns.forEach((r) => {
    rows.push([
      "Salary run detail",
      r.teacherName,
      `Pay period ${localDateKey(r.periodStart)} to ${localDateKey(r.periodEnd)}; finalized ${localDateKey(r.finalizedAt)}`,
      "",
      r.netAmount,
    ]);
  });

  const modeTitle = report.mode.charAt(0).toUpperCase() + report.mode.slice(1);
  return {
    rows,
    sheetName: `${modeTitle} Report`,
    moneyCols: [4],
    boldRows: [netRowIdx - 1, netRowIdx],
  };
}

// finance-report-daily-2026-11-12.xlsx / finance-report-monthly-2026-11-01-to-2026-11-30.csv
function financeReportFilename(mode, from, to, format) {
  const range = from === to ? from : `${from}-to-${to}`;
  return `finance-report-${mode}-${range}.${format}`;
}

// ── Expense / income history ────────────────────────────────────────────────

async function callHistoryService(service, filters) {
  const { res: cap, result } = captureServiceResponse();
  await service(filters, cap);
  if (!result.ok) return { ok: false, message: result.message || "Failed to load history" };
  return { ok: true, data: result.body.data };
}

// Walks every page of the FILTERED history through the same service the page
// uses (same validation, same sort, same running-total aggregate). Any page
// failing aborts the whole export — a partial file is never served.
async function fetchHistoryForExport(kind, filters) {
  const service = kind === "expense" ? getExpenseEntriesService : getIncomeEntriesService;
  const headKey = kind === "expense" ? "expenseHead" : "incomeHead";
  const base = {
    [headKey]: filters[headKey] || "",
    from: filters.from || "",
    to: filters.to || "",
  };

  try {
    const first = await callHistoryService(service, { ...base, page: 1, limit: HISTORY_PAGE_LIMIT });
    if (!first.ok) return first;

    const pages = first.data.pagination ? first.data.pagination.pages : 0;
    if (pages > MAX_EXPORT_PAGES) {
      return { ok: false, message: "Too many entries to export — narrow the date range or head filter" };
    }

    const entries = [...(first.data.entries || [])];
    for (let page = 2; page <= pages; page++) {
      const next = await callHistoryService(service, { ...base, page, limit: HISTORY_PAGE_LIMIT });
      if (!next.ok) return next;
      entries.push(...(next.data.entries || []));
    }

    return { ok: true, entries, runningTotal: first.data.runningTotal, count: first.data.count };
  } catch (err) {
    return { ok: false, message: err.message || "Failed to load history" };
  }
}

// Columns mirror the on-screen history table; the running-total row closes
// the sheet exactly like the filtered total shown above the table.
function buildHistoryExport(kind, { entries, runningTotal }) {
  const isExpense = kind === "expense";
  const headField = isExpense ? "expenseHead" : "incomeHead";
  const rows = [
    ["Date", "Head", isExpense ? "Item" : "Description", "Quantity", "Unit rate (Rs)", "Total (Rs)", "Notes", "Recorded by"],
  ];

  (entries || []).forEach((e) => {
    const head = e[headField];
    rows.push([
      localDateKey(e.date),
      head ? headLabel(head) : "",
      (isExpense ? e.itemName : e.description) || "",
      e.quantity !== undefined && e.quantity !== null ? e.quantity : "",
      e.unitRate !== undefined && e.unitRate !== null ? e.unitRate : "",
      e.totalAmount,
      e.notes || "",
      e.createdBy ? e.createdBy.name : "",
    ]);
  });

  rows.push(["", "", "Running total (filtered)", "", "", runningTotal, "", ""]);

  return {
    rows,
    sheetName: isExpense ? "Expense History" : "Income History",
    moneyCols: [4, 5],
    boldRows: [rows.length - 1],
  };
}

// expense-history-2026-11-01-to-2026-11-30.csv (open-ended ranges stay legible)
function historyFilename(kind, from, to, format) {
  const base = kind === "expense" ? "expense-history" : "income-history";
  let range = "all";
  if (from && to) range = `${from}-to-${to}`;
  else if (from) range = `${from}-onwards`;
  else if (to) range = `up-to-${to}`;
  return `${base}-${range}.${format}`;
}

module.exports = {
  normalizeExportFormat,
  fetchReportForExport,
  buildFinanceReportExport,
  financeReportFilename,
  fetchHistoryForExport,
  buildHistoryExport,
  historyFilename,
};