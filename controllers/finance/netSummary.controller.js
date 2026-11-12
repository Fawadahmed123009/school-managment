const responseStatus = require("../../handlers/responseStatus.handler");
const { getNetSummaryService } = require("../../services/finance/netSummary.service");

// ADMIN ONLY (isLoggedIn + isAdmin at the router). Read-only net profit/loss
// building block: collections + income − expenses for an inclusive date range.
// Phase 4 daily/monthly/yearly reports consume this endpoint.

exports.getNetSummaryController = async (req, res) => {
  try {
    await getNetSummaryService(
      { from: req.query.from || "", to: req.query.to || "" },
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};