const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createAssignmentService,
  createBatchAssignmentService,
  getAllAssignmentsService,
  getMyAssignmentsService,
  deleteAssignmentService,
} = require("../../services/academic/assignment.service");

exports.createAssignmentController = async (req, res) => {
  try {
    // Support both single classLevel and batch classLevels[]
    if (req.body.classLevels && Array.isArray(req.body.classLevels)) {
      await createBatchAssignmentService(req.body, req.userAuth.id, res);
    } else {
      await createAssignmentService(req.body, req.userAuth.id, res);
    }
  } catch (error) {
    // Handle MongoDB duplicate key error (E11000)
    if (error.code === 11000) {
      return responseStatus(res, 400, "failed", "This teacher is already assigned to this subject for this class");
    }
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAllAssignmentsController = async (req, res) => {
  try {
    const result = await getAllAssignmentsService(req.query);
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getMyAssignmentsController = async (req, res) => {
  try {
    await getMyAssignmentsService(req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.deleteAssignmentController = async (req, res) => {
  try {
    await deleteAssignmentService(req.params.assignmentId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
