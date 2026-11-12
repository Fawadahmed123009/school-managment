const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const { todayKey } = require("../../utils/dateRange");
const { localDateKey } = require("../../utils/localDateKey");
const { getFinanceReportService } = require("../../services/finance/financeReport.service");

// Phase 4 financial reports — Daily / Monthly / Yearly. ADMIN ONLY on every
// route (requireRole resolves the role from the DB via authView): managers
// never see financial reports, mirroring the Expenses/Income/Salary pattern.
// Read-only pages: each is a GET picker form over the shared reporting
// service (which composes the net-summary core + head breakdowns + finalized
// salaries). No write path exists here.

// ── helpers ─────────────────────────────────────────────────────────────────

// Money display follows the fees/salary/expense/income views ("Rs", 2 decimals).
const fmtRs = (n) => "Rs " + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

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
      reports: REPORTS.map((r) => ({ path: r.path, title: r.title, mode: r.mode })),
      fmtRs,
      localDateKey,
      schoolName: res.locals.schoolName,
    });
  };
}

REPORTS.forEach((cfg) => {
  router.get(cfg.path, requireRole("admin"), reportView(cfg));
});

module.exports = router;
