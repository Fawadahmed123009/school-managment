const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createExpenseEntryService,
  getExpenseEntriesService,
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
