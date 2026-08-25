const express = require("express");
const router = express.Router();
const pdfReportController = require("../../../controllers/academic/pdfReport.controller");
const isLoggedIn = require("../../../middlewares/isLoggedIn");

// Generate PDFs
router.post("/pdf-reports/result-sheet", isLoggedIn, pdfReportController.generateResultSheet);
router.post("/pdf-reports/analytics", isLoggedIn, pdfReportController.generateAnalytics);
router.post("/pdf-reports/session-report", isLoggedIn, pdfReportController.generateSessionReport);

// Serve generated PDF by UUID (unguessable URL)
router.get("/pdf-reports/:uuid", pdfReportController.servePdf);

module.exports = router;
