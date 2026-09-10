const express = require("express");
const testRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isTeacher = require("../../../middlewares/isTeacher");
const isAssignedToSubject = require("../../../middlewares/isAssignedToSubject");
const Teacher = require("../../../models/Staff/teachers.model");
const responseStatus = require("../../../handlers/responseStatus.handler");

const {
  createTestSessionController,
  getAllTestSessionsController,
  getTestSessionByIdController,
} = require("../../../controllers/academic/testSession.controller");

const {
  createTestController,
  getAllTestsController,
  getTestsByRoleController,
  getTeacherAssignedClassesController,
  getTeacherAssignedSubjectsController,
  getTeacherScopedTestsByClassSubjectController,
  getTestRosterController,
  submitTestResultsController,
  getTestResultSheetController,
  getTestAnalyticsController,
  getEnhancedTestAnalyticsController,
  getTestTrendController,
  getTeacherAnalyticsController,
  getSessionReportCardController,
  deleteTestController,
} = require("../../../controllers/academic/test.controller");

// ── Combined middleware: allows both admin and teacher ──────────────────────
// Checks the Teacher model to determine role; falls through to admin check.
const isAdminOrTeacher = async (req, res, next) => {
  try {
    const userId = req.userAuth.id;
    const teacher = await Teacher.findById(userId);
    if (teacher) return next(); // is a teacher
    // Not a teacher → check if admin
    const Admin = require("../../../models/Staff/admin.model");
    const admin = await Admin.findById(userId);
    if (admin && admin.role === "admin") return next();
    return responseStatus(res, 403, "failed", "Access Denied. Admin or teacher only route.");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying access");
  }
};

// ── Combined middleware: teacher with assignment check OR manager ────────────
// Manager can mark ANY test without subject-assignment check.
// Regular teachers still need the assignment verification.
const isTeacherAssignedOrManager = async (req, res, next) => {
  try {
    const userId = req.userAuth.id;
    const teacher = await Teacher.findById(userId);
    // Manager bypass: skip assignment check
    if (teacher && teacher.isAttendanceManager) return next();
    // Regular teacher: require subject assignment
    if (teacher && teacher.role === "teacher") {
      return isAssignedToSubject(req, res, next);
    }
    return responseStatus(res, 403, "failed", "Access Denied. Teacher or manager only route.");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying access");
  }
};

// ── Test sessions (admin/manager) ───────────────────────────────────────────
testRouter.route("/test-sessions").post(isLoggedIn, isAdminOrManager, createTestSessionController);
testRouter.route("/test-sessions").get(isLoggedIn, isAdminOrManager, getAllTestSessionsController);
testRouter.route("/test-sessions/:sessionId").get(isLoggedIn, isAdminOrManager, getTestSessionByIdController);
testRouter.route("/test-sessions/:sessionId/report/:studentId").get(isLoggedIn, isAdminOrManager, getSessionReportCardController);

// ── Tests ───────────────────────────────────────────────────────────────────
// POST /tests — admin/manager (creating tests is an admin/manager action)
testRouter.route("/tests").post(isLoggedIn, isAdminOrManager, createTestController);
// GET /tests — admin sees all; teacher sees only their assigned subjects/classes
testRouter.route("/tests").get(isLoggedIn, isAdminOrTeacher, getTestsByRoleController);

// ── Cascade API routes for Class → Subject → Test dropdown ─────────────────
// These must come BEFORE /:testId routes to avoid route conflicts.
// Only teachers need these; managers/admins use the full test list.
testRouter.get("/tests/cascade/classes", isLoggedIn, isTeacher, getTeacherAssignedClassesController);
testRouter.get("/tests/cascade/subjects", isLoggedIn, isTeacher, getTeacherAssignedSubjectsController);
testRouter.get("/tests/cascade/tests", isLoggedIn, isTeacher, getTeacherScopedTestsByClassSubjectController);

testRouter.route("/tests/analytics").get(isLoggedIn, isAdminOrManager, getTestAnalyticsController);
testRouter.route("/tests/analytics/enhanced").get(isLoggedIn, isAdminOrManager, getEnhancedTestAnalyticsController);
testRouter.route("/tests/analytics/trend").get(isLoggedIn, isAdminOrManager, getTestTrendController);
// Teacher-scoped analytics (assignment-gated, read-only)
testRouter.route("/tests/teacher-analytics").get(isLoggedIn, isTeacher, getTeacherAnalyticsController);

// Test marking routes — manager can mark ANY test; teachers need assignment check
testRouter.route("/tests/:testId/roster").get(isLoggedIn, isTeacherAssignedOrManager, getTestRosterController);
testRouter.route("/tests/:testId/results").post(isLoggedIn, isTeacherAssignedOrManager, submitTestResultsController);
testRouter.route("/tests/:testId/result-sheet").get(isLoggedIn, isAdminOrManager, getTestResultSheetController);

// DELETE /tests/:testId — admin/manager only; cascades to TestResult documents
testRouter.route("/tests/:testId").delete(isLoggedIn, isAdminOrManager, deleteTestController);

module.exports = testRouter;
