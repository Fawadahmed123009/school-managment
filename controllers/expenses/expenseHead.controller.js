const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createExpenseHeadService,
  getAllExpenseHeadsService,
  toggleExpenseHeadService,
} = require("../../services/expenses/expenseHead.service");

// Every controller here sits behind isLoggedIn + isAdmin at the router —
// expenses are ADMIN ONLY (managers never see expense data), mirroring Salary.

exports.createExpenseHeadController = async (req, res) => {
  try {
    await createExpenseHeadService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAllExpenseHeadsController = async (req, res) => {
  try {
    const result = await getAllExpenseHeadsService(req.query);
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Form bodies arrive as strings, so normalize the checkbox/flag here before the
// service coerces it (same pattern as the salary settings controller).
exports.toggleExpenseHeadController = async (req, res) => {
  try {
    const raw = req.body.isActive;
    const isActive = raw === true || raw === "true" || raw === "on" || raw === "1";
    await toggleExpenseHeadService(req.params.id, isActive, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
