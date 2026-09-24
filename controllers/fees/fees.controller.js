const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createFeeService,
  bulkCreateFeesService,
  bulkAssignFeesService,
  generateMonthlyFeesService,
  getAllFeesService,
  getStudentFeesService,
  updateFeeService,
  deleteFeeService,
  getFeeAuditService,
  resolveOcrReviewService,
} = require("../../services/fees/fees.service");

exports.createFeeController = async (req, res) => {
  try {
    await createFeeService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.bulkCreateFeesController = async (req, res) => {
  try {
    await bulkCreateFeesService(req.body.fees, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAllFeesController = async (req, res) => {
  try {
    const { page, limit, ...filters } = req.query;
    await getAllFeesService(filters, { page, limit }, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getStudentFeesController = async (req, res) => {
  try {
    await getStudentFeesService(req.params.studentId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.updateFeeController = async (req, res) => {
  try {
    await updateFeeService(req.params.feeId, req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.deleteFeeController = async (req, res) => {
  try {
    // C2: soft delete + audit row, so the actor must travel with the request.
    await deleteFeeService(req.params.feeId, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// GET /api/v1/fees/audit — fee audit trail (who changed/removed what, when).
exports.getFeeAuditController = async (req, res) => {
  try {
    await getFeeAuditService(req.query, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.bulkAssignFeesController = async (req, res) => {
  try {
    await bulkAssignFeesService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.resolveOcrReviewController = async (req, res) => {
  try {
    await resolveOcrReviewService(req.params.feeId, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.generateMonthlyFeesController = async (req, res) => {
  try {
    await generateMonthlyFeesService(req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
