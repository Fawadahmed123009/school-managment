const express = require("express");
const router = express.Router();
const pdfReportController = require("../../../controllers/academic/pdfReport.controller");
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrTeacher = require("../../../middlewares/isAdminOrTeacher");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");

// Generate PDFs
router.post("/pdf-reports/result-sheet", isLoggedIn, isAdminOrTeacher, pdfReportController.generateResultSheet);
router.post("/pdf-reports/analytics", isLoggedIn, isAdminOrTeacher, pdfReportController.generateAnalytics);
router.post("/pdf-reports/session-report", isLoggedIn, isAdminOrTeacher, pdfReportController.generateSessionReport);
router.post("/pdf-reports/session-report-bulk", isLoggedIn, isAdminOrTeacher, pdfReportController.generateSessionReportBulk);

// Session-scoped student picker for the report form (admin/manager only — the
// session report it feeds is gated the same way). MUST precede the ":uuid"
// param route so "session-students" is not captured as a uuid.
router.get("/pdf-reports/session-students", isLoggedIn, isAdminOrManager, pdfReportController.getSessionScopedStudents);

// Shared role-scoped student picker feeding ALL three report filter cascades
// (result sheet / session report / analytics). MUST precede the ":uuid" param
// route so "teacher-students" is not captured as a uuid.
router.get("/pdf-reports/teacher-students", isLoggedIn, isAdminOrTeacher, pdfReportController.getTeacherScopedStudents);

// Serve generated PDF by UUID (unguessable URL)
router.get("/pdf-reports/:uuid", isLoggedIn, isAdminOrTeacher, pdfReportController.servePdf);

module.exports = router;
