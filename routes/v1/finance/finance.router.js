const express = require("express");
const financeRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");

const { getNetSummaryController } = require("../../../controllers/finance/netSummary.controller");
const { getFinanceReportController } = require("../../../controllers/finance/financeReport.controller");

// Finance summary — net profit/loss building block for Phase 4 reporting.
// ADMIN ONLY (isAdmin resolves the role from the DB). Read-only: returns fee
// collections + ad-hoc income − expenses for an inclusive local date range.
// No existing collections/expense route or logic is altered.
financeRouter.route("/net-summary")
  .get(isLoggedIn, isAdmin, getNetSummaryController);

// Phase 4 financial reports — daily/monthly/yearly, composing the net-summary
// core plus income/expense head breakdowns and finalized salary runs.
// ADMIN ONLY, read-only. Net folds salaries in (Admin-confirmed).
financeRouter.route("/finance-report")
  .get(isLoggedIn, isAdmin, getFinanceReportController);

module.exports = financeRouter;