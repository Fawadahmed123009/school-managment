const responseStatus = require("../../handlers/responseStatus.handler");
const { getFinanceReportService } = require("../../services/finance/financeReport.service");

// ADMIN ONLY (isLoggedIn + isAdmin at the router). Read-only Phase 4 report:
// daily/monthly/yearly collections + income-by-head + expenses-by-head +
// finalized salaries, with net = collections + income − expenses − salaries.
// Composes the shared net-summary core — no underlying finance logic altered.

exports.getFinanceReportController = async (req, res) => {
  try {
    await getFinanceReportService(
      {
        mode: req.query.mode || "",
        date: req.query.date || "",
        month: req.query.month || "",
        year: req.query.year || "",
      },
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
