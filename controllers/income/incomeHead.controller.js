const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createIncomeHeadService,
  getAllIncomeHeadsService,
  toggleIncomeHeadService,
} = require("../../services/income/incomeHead.service");

// Every controller here sits behind isLoggedIn + isAdmin at the router —
// income is ADMIN ONLY (managers never see income data), mirroring Expenses.

exports.createIncomeHeadController = async (req, res) => {
  try {
    await createIncomeHeadService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAllIncomeHeadsController = async (req, res) => {
  try {
    const result = await getAllIncomeHeadsService(req.query);
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Form bodies arrive as strings, so normalize the checkbox/flag here before the
// service coerces it (same pattern as the expense head controller).
exports.toggleIncomeHeadController = async (req, res) => {
  try {
    const raw = req.body.isActive;
    const isActive = raw === true || raw === "true" || raw === "on" || raw === "1";
    await toggleIncomeHeadService(req.params.id, isActive, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};