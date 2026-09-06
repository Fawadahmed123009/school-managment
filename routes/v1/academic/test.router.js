const express = require("express");
const testRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");
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
  getTestRosterController,
  submitTestResultsController,
  getTestResultSheetController,
  getTestAnalyticsController,
  getEnhancedTestAnalyticsController,
  getTestTrendController,
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

// ── Test sessions (admin only) ──────────────────────────────────────────────
testRouter.route("/test-sessions").post(isLoggedIn, isAdmin, createTestSessionController);
testRouter.route("/test-sessions").get(isLoggedIn, isAdmin, getAllTestSessionsController);
testRouter.route("/test-sessions/:sessionId").get(isLoggedIn, isAdmin, getTestSessionByIdController);
testRouter.route("/test-sessions/:sessionId/report/:studentId").get(isLoggedIn, isAdmin, getSessionReportCardController);

// ── Tests ───────────────────────────────────────────────────────────────────
// POST /tests — admin only (creating tests is an admin action)
testRouter.route("/tests").post(isLoggedIn, isAdmin, createTestController);
// GET /tests — admin sees all; teacher sees only their assigned subjects/classes
testRouter.route("/tests").get(isLoggedIn, isAdminOrTeacher, getTestsByRoleController);
testRouter.route("/tests/analytics").get(isLoggedIn, isAdmin, getTestAnalyticsController);
testRouter.route("/tests/analytics/enhanced").get(isLoggedIn, isAdmin, getEnhancedTestAnalyticsController);
testRouter.route("/tests/analytics/trend").get(isLoggedIn, isAdmin, getTestTrendController);

// Teacher-facing test routes — assignment check via middleware (primary gate)
// Service-level checks in test.service.js are kept as defense-in-depth.
testRouter.route("/tests/:testId/roster").get(isLoggedIn, isTeacher, isAssignedToSubject, getTestRosterController);
testRouter.route("/tests/:testId/results").post(isLoggedIn, isTeacher, isAssignedToSubject, submitTestResultsController);
testRouter.route("/tests/:testId/result-sheet").get(isLoggedIn, isAdmin, getTestResultSheetController);

// DELETE /tests/:testId — admin only; cascades to TestResult documents
testRouter.route("/tests/:testId").delete(isLoggedIn, isAdmin, deleteTestController);

module.exports = testRouter;
