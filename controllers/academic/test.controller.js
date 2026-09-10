const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createTestService,
  getAllTestsService,
  getTeacherScopedTestsService,
  getTeacherAssignedClassesService,
  getTeacherAssignedSubjectsService,
  getTeacherScopedTestsByClassSubjectService,
  getTestRosterService,
  submitTestResultsService,
  getTestResultSheetService,
  getTestAnalyticsService,
  getEnhancedTestAnalyticsService,
  getTestTrendService,
  getTeacherAnalyticsService,
  deleteTestService,
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

exports.getEnhancedTestAnalyticsController = async (req, res) => {
  try {
    await getEnhancedTestAnalyticsService(req.query, res);
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

exports.getTestTrendController = async (req, res) => {
  try {
    await getTestTrendService(req.query, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.deleteTestController = async (req, res) => {
  try {
    await deleteTestService(req.params.testId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Teacher-scoped analytics: per-class and per-session score stats
exports.getTeacherAnalyticsController = async (req, res) => {
  try {
    const filters = {
      classLevel: req.query.classLevel || "",
      subject: req.query.subject || "",
      testId: req.query.testId || "",
      sessionId: req.query.sessionId || "",
      fromDate: req.query.fromDate || "",
      toDate: req.query.toDate || "",
    };
    await getTeacherAnalyticsService(req.userAuth.id, filters, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// ── Cascade API controllers ──────────────────────────────────────────────────
// Three-level cascade: Class → Subject → Test for teacher test-marking views.

/**
 * GET /api/v1/tests/cascade/classes
 * Returns distinct classes the teacher is assigned to.
 */
exports.getTeacherAssignedClassesController = async (req, res) => {
  try {
    await getTeacherAssignedClassesService(req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * GET /api/v1/tests/cascade/subjects?classLevel=xxx
 * Returns distinct subjects the teacher is assigned to for the given class.
 * Security: validates teacher is actually assigned to the classLevel.
 */
exports.getTeacherAssignedSubjectsController = async (req, res) => {
  try {
    await getTeacherAssignedSubjectsService(req.userAuth.id, req.query.classLevel, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * GET /api/v1/tests/cascade/tests?classLevel=xxx&subject=yyy
 * Returns tests matching both class and subject.
 * Security: validates teacher is actually assigned to this class+subject combo.
 */
exports.getTeacherScopedTestsByClassSubjectController = async (req, res) => {
  try {
    await getTeacherScopedTestsByClassSubjectService(
      req.userAuth.id,
      req.query.classLevel,
      req.query.subject,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
