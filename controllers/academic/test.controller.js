const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createTestService,
  getAllTestsService,
  getTeacherScopedTestsService,
  getTestRosterService,
  submitTestResultsService,
  getTestResultSheetService,
  getTestAnalyticsService,
} = require("../../services/academic/test.service");

exports.createTestController = async (req, res) => {
  try {
    await createTestService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAllTestsController = async (req, res) => {
  try {
    await getAllTestsService(res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Admin sees all tests; teacher sees only tests for their assigned subjects/classes.
exports.getTestsByRoleController = async (req, res) => {
  try {
    const Teacher = require("../../models/Staff/teachers.model");
    const isTeacherUser = await Teacher.findById(req.userAuth.id);

    if (isTeacherUser) {
      await getTeacherScopedTestsService(req.userAuth.id, res);
    } else {
      await getAllTestsService(res);
    }
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getTestRosterController = async (req, res) => {
  try {
    await getTestRosterService(req.params.testId, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.submitTestResultsController = async (req, res) => {
  try {
    await submitTestResultsService(req.params.testId, req.body.records, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getTestResultSheetController = async (req, res) => {
  try {
    await getTestResultSheetService(req.params.testId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getTestAnalyticsController = async (req, res) => {
  try {
    await getTestAnalyticsService(req.query, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getSessionReportCardController = async (req, res) => {
  try {
    const { getSessionReportCardService } = require("../../services/academic/test.service");
    await getSessionReportCardService(req.params.sessionId, req.params.studentId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
