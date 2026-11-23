const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createIncomeEntryService,
  getIncomeEntriesService,
  updateIncomeEntryService,
  deleteIncomeEntryService,
} = require("../../services/income/incomeEntry.service");

// ADMIN ONLY (isLoggedIn + isAdmin at the router). The service derives the mode
// (quantity × rate vs direct total) from which fields are present and validates/
// normalises totalAmount server-side — a client total is never blindly trusted.

exports.createIncomeEntryController = async (req, res) => {
  try {
    const { incomeHead, date, description, quantity, unitRate, totalAmount, notes } = req.body;
    await createIncomeEntryService(
      { incomeHead, date, description, quantity, unitRate, totalAmount, notes },
      req.userAuth.id,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getIncomeEntriesController = async (req, res) => {
  try {
    const filters = {
      incomeHead: req.query.incomeHead || "",
      from: req.query.from || "",
      to: req.query.to || "",
      page: req.query.page,
      limit: req.query.limit,
    };
    await getIncomeEntriesService(filters, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Edit an income entry — the service derives the mode from the submitted fields
// and recomputes/validates totalAmount server-side. ADMIN ONLY (router).
exports.updateIncomeEntryController = async (req, res) => {
  try {
    const { incomeHead, date, description, quantity, unitRate, totalAmount, notes } = req.body;
    await updateIncomeEntryService(
      req.params.id,
      { incomeHead, date, description, quantity, unitRate, totalAmount, notes },
      req.userAuth.id,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Soft-delete an income entry (flagged + audited, never hard-removed). ADMIN ONLY.
exports.deleteIncomeEntryController = async (req, res) => {
  try {
    await deleteIncomeEntryService(req.params.id, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};