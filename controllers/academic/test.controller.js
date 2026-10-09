const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createTestService,
  getTestByIdService,
  updateTestService,
  getAllTestsService,
  getTeacherScopedTestsService,
  getTeacherAssignedClassesService,
  getTeacherAssignedSubjectsService,
  getTeacherScopedTestsByClassSubjectService,
  getTeacherCascadeSessionsService,
  getTeacherCascadePhasesService,
  getTeacherCascadeWeeksService,
  getTestRosterService,
  submitTestResultsService,
  getMarksAuditService,
  updateTestMarksService,
  getTestMarksService,
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

exports.getTestByIdController = async (req, res) => {
  try {
    await getTestByIdService(req.params.testId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Edit a test's own fields (admin/manager — "Manage tests" → Edit)
exports.updateTestController = async (req, res) => {
  try {
    await updateTestService(req.params.testId, req.body, res);
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

// Admin and manager see ALL tests school-wide; a regular (non-manager) teacher
// sees only tests for their assigned subjects/classes.
//
// CRITICAL: manager status is resolved from the DATABASE, keyed off the verified
// token id (req.userAuth.id). The API JWT carries only `{ id }` — there is no
// role/manager claim on the token at all — so req.userAuth.role / req.user.role
// can never be trusted here (and would be absent or forgeable). This mirrors the
// resolveCaller / resolveIdentityFromDb pattern used by every other role fix.
exports.getTestsByRoleController = async (req, res) => {
  try {
    const Teacher = require("../../models/Staff/teachers.model");
    const teacher = await Teacher.findById(req.userAuth.id)
      .select("isAttendanceManager")
      .lean();

    // Manager (teacher with isAttendanceManager) → full school-wide list,
    // exactly like an admin. Regular teacher → assignment-scoped list.
    // Non-teacher (an admin id) → full list.
    if (teacher && !teacher.isAttendanceManager) {
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

// Admin/manager marks audit — per-test stats + marking timeline (read-only)
exports.getMarksAuditController = async (req, res) => {
  try {
    await getMarksAuditService(req.query, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Edit total/pass marks for a test (mark-entry page scale fix)
exports.updateTestMarksController = async (req, res) => {
  try {
    await updateTestMarksService(req.params.testId, req.body, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Read a test's total/pass marks (for the scan & enter marks page)
exports.getTestMarksController = async (req, res) => {
  try {
    await getTestMarksService(req.params.testId, res);
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
    // req.userAuth.id is the verified token id (the API JWT carries only `{ id }`);
    // the service resolves the acting identity from the DB for the audit trail.
    await deleteTestService(req.params.testId, req.userAuth.id, res);
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
 * GET /api/v1/tests/cascade/tests?classLevel=xxx&subject=yyy[&session=zzz][&phase=ppp][&week=www]
 * Returns tests matching both class and subject, optionally narrowed by session/phase/week.
 * Security: validates teacher is actually assigned to this class+subject combo.
 */
exports.getTeacherScopedTestsByClassSubjectController = async (req, res) => {
  try {
    await getTeacherScopedTestsByClassSubjectService(
      req.userAuth.id,
      req.query.classLevel,
      req.query.subject,
      req.query.session || null,
      req.query.phase || null,
      req.query.week || null,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * GET /api/v1/tests/cascade/sessions?classLevel=xxx&subject=yyy
 * Returns distinct sessions that have tests for the selected class+subject.
 */
exports.getTeacherCascadeSessionsController = async (req, res) => {
  try {
    await getTeacherCascadeSessionsService(
      req.userAuth.id,
      req.query.classLevel,
      req.query.subject,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * GET /api/v1/tests/cascade/phases?classLevel=xxx&subject=yyy&session=zzz
 * Returns distinct phases from a session that have tests for the selected class+subject.
 */
exports.getTeacherCascadePhasesController = async (req, res) => {
  try {
    await getTeacherCascadePhasesService(
      req.userAuth.id,
      req.query.classLevel,
      req.query.subject,
      req.query.session,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * GET /api/v1/tests/cascade/weeks?classLevel=xxx&subject=yyy&session=zzz&phase=ppp
 * Returns weeks for a session+phase that have tests for the selected class+subject.
 */
exports.getTeacherCascadeWeeksController = async (req, res) => {
  try {
    await getTeacherCascadeWeeksService(
      req.userAuth.id,
      req.query.classLevel,
      req.query.subject,
      req.query.session,
      req.query.phase,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
