const express = require("express");
const router = express.Router();
const pdfReportController = require("../../../controllers/academic/pdfReport.controller");
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrTeacher = require("../../../middlewares/isAdminOrTeacher");

// Generate PDFs
router.post("/pdf-reports/result-sheet", isLoggedIn, isAdminOrTeacher, pdfReportController.generateResultSheet);
router.post("/pdf-reports/analytics", isLoggedIn, isAdminOrTeacher, pdfReportController.generateAnalytics);
router.post("/pdf-reports/session-report", isLoggedIn, isAdminOrTeacher, pdfReportController.generateSessionReport);

// Serve generated PDF by UUID (unguessable URL)
router.get("/pdf-reports/:uuid", isLoggedIn, isAdminOrTeacher, pdfReportController.servePdf);

module.exports = router;
