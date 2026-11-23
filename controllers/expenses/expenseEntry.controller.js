const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createExpenseEntryService,
  getExpenseEntriesService,
  updateExpenseEntryService,
  deleteExpenseEntryService,
} = require("../../services/expenses/expenseEntry.service");

// ADMIN ONLY (isLoggedIn + isAdmin at the router). totalAmount is recomputed in
// the service — the client never supplies a trusted total.

exports.createExpenseEntryController = async (req, res) => {
  try {
    const { expenseHead, date, itemName, quantity, unitRate, notes } = req.body;
    await createExpenseEntryService(
      { expenseHead, date, itemName, quantity, unitRate, notes },
      req.userAuth.id,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getExpenseEntriesController = async (req, res) => {
  try {
    const filters = {
      expenseHead: req.query.expenseHead || "",
      from: req.query.from || "",
      to: req.query.to || "",
      page: req.query.page,
      limit: req.query.limit,
    };
    await getExpenseEntriesService(filters, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Edit an expense entry — the service recomputes totalAmount server-side.
// ADMIN ONLY (router).
exports.updateExpenseEntryController = async (req, res) => {
  try {
    const { expenseHead, date, itemName, quantity, unitRate, notes } = req.body;
    await updateExpenseEntryService(
      req.params.id,
      { expenseHead, date, itemName, quantity, unitRate, notes },
      req.userAuth.id,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Soft-delete an expense entry (flagged + audited, never hard-removed). ADMIN ONLY.
exports.deleteExpenseEntryController = async (req, res) => {
  try {
    await deleteExpenseEntryService(req.params.id, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
