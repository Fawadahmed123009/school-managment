const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createAssignmentService,
  getAllAssignmentsService,
  getMyAssignmentsService,
  deleteAssignmentService,
} = require("../../services/academic/assignment.service");

exports.createAssignmentController = async (req, res) => {
  try {
    await createAssignmentService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAllAssignmentsController = async (req, res) => {
  try {
    await getAllAssignmentsService(res);
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
