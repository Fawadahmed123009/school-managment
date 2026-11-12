const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const { todayKey } = require("../../utils/dateRange");
const { localDateKey } = require("../../utils/localDateKey");
const { getFinanceReportService } = require("../../services/finance/financeReport.service");
const {
  normalizeExportFormat,
  fetchReportForExport,
  buildFinanceReportExport,
  financeReportFilename,
} = require("../../services/finance/financeExport.service");
const { sendExport } = require("../../utils/exportFile");
const { getMonthlyTrend, getDailyTrend } = require("../../services/finance/financeTrend.service");

// Phase 4 financial reports — Daily / Monthly / Yearly. ADMIN ONLY on every
// route (requireRole resolves the role from the DB via authView): managers
// never see financial reports, mirroring the Expenses/Income/Salary pattern.
// Read-only pages: each is a GET picker form over the shared reporting
// service (which composes the net-summary core + head breakdowns + finalized
// salaries). No write path exists here.

// ── helpers ─────────────────────────────────────────────────────────────────

// Money display follows the fees/salary/expense/income views ("Rs", 2 decimals).
const fmtRs = (n) => "Rs " + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// Compact money for tight chart spaces (donut centers) — display only, the
// full-precision figure stays in the table/tooltip next to it.
const fmtRsCompact = (n) => {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  if (abs >= 1e7) return "Rs " + (v / 1e7).toFixed(abs >= 1e8 ? 0 : 1) + "Cr";
  if (abs >= 1e5) return "Rs " + (v / 1e5).toFixed(abs >= 1e6 ? 0 : 1) + "L";
  if (abs >= 1e3) return "Rs " + (v / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + "k";
  return "Rs " + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

// One config per report mode — the three pages differ ONLY in picker + range.
const REPORTS = [
  {
    mode: "daily",
    path: "/finance/daily-report",
    page: "finance-daily",
    title: "Daily Report",
    param: "date",
    pickerType: "date",
    pickerLabel: "Date",
    defaultValue: () => todayKey(),
  },
  {
    mode: "monthly",
    path: "/finance/monthly-report",
    page: "finance-monthly",
    title: "Monthly Report",
    param: "month",
    pickerType: "month",
    pickerLabel: "Month",
    defaultValue: () => todayKey().slice(0, 7),
  },
  {
    mode: "yearly",
    path: "/finance/yearly-report",
    page: "finance-yearly",
    title: "Yearly Report",
    param: "year",
    pickerType: "number",
    pickerLabel: "Year",
    defaultValue: () => todayKey().slice(0, 4),
  },
];

function reportView(cfg) {
  return async (req, res) => {
    // Default picker = today / current month / current year (server-LOCAL day
    // via the shared dateRange helper — never a UTC toISOString slice).
    const raw = req.query[cfg.param];
    const value = raw !== undefined && String(raw).trim() !== "" ? String(raw).trim() : cfg.defaultValue();

    let report = null;
    let loadError = null;
    try {
      const { res: cap, result } = captureServiceResponse();
      await getFinanceReportService({ mode: cfg.mode, [cfg.param]: value }, cap);
      if (result.ok) report = result.body.data;
      else loadError = result.message;
    } catch (err) {
      loadError = err.message;
    }

    // ── Trend charts (pure visual layer) ─────────────────────────────────
    // Yearly page: 12 monthly-report points; Monthly page: day-by-day net.
    // Composed from the SAME report service (financeTrend.service) — never a
    // second calculation path. Fail-soft: a trend failure must not break the
    // tabular report, so it degrades to a notice above the charts.
    let trend = null;
    let dailyTrend = null;
    let trendError = null;
    if (report) {
      try {
        if (cfg.mode === "yearly") {
          const t = await getMonthlyTrend(value);
          if (t.error) trendError = t.error;
          else trend = t;
        } else if (cfg.mode === "monthly") {
          const t = await getDailyTrend(value);
          if (t.error) trendError = t.error;
          else dailyTrend = t;
        }
      } catch (err) {
        trendError = err.message || "Trend data could not be loaded";
      }
    }

    res.render("finance/report", {
      page: cfg.page,
      user: req.user,
      mode: cfg.mode,
      title: cfg.title,
      param: cfg.param,
      pickerType: cfg.pickerType,
      pickerLabel: cfg.pickerLabel,
      value,
      report,
      loadError,
      trend,
      dailyTrend,
      trendError,
      reports: REPORTS.map((r) => ({ path: r.path, title: r.title, mode: r.mode })),
      fmtRs,
      fmtRsCompact,
      localDateKey,
      schoolName: res.locals.schoolName,
    });
  };
}

// CSV/Excel export of the SAME report the page shows — same picker value,
// same service, admin-only, read-only GET (no CSRF needed, like the picker).
// On a bad picker value we bounce back to the report page, which renders the
// identical loadError for that value.
function reportExportView(cfg) {
  return async (req, res) => {
    const format = normalizeExportFormat(req.query.format);
    if (!format) return res.status(400).send("Invalid export format — expected csv or xlsx");

    const raw = req.query[cfg.param];
    const value = raw !== undefined && String(raw).trim() !== "" ? String(raw).trim() : cfg.defaultValue();

    const loaded = await fetchReportForExport({ mode: cfg.mode, [cfg.param]: value });
    if (!loaded.ok) return res.redirect(`${cfg.path}?${cfg.param}=${encodeURIComponent(value)}`);

    const report = loaded.report;
    return sendExport(res, {
      filename: financeReportFilename(report.mode, report.from, report.to, format),
      format,
      ...buildFinanceReportExport(report),
    });
  };
}

REPORTS.forEach((cfg) => {
  router.get(cfg.path, requireRole("admin"), reportView(cfg));
  router.get(cfg.path + "/export", requireRole("admin"), reportExportView(cfg));
});

module.exports = router;
