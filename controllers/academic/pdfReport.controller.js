const fs = require("fs");
const pdfReportService = require("../../services/academic/pdfReport.service");
const responseStatus = require("../../handlers/responseStatus.handler");

// POST /pdf-reports/result-sheet
exports.generateResultSheet = async (req, res) => {
  try {
    const { testId } = req.body;
    if (!testId) return responseStatus(res, 400, "failed", "testId is required");

    const schoolName = process.env.SCHOOL_NAME || "School Portal";
    const result = await pdfReportService.generateResultSheetPDF(testId, schoolName);

    return responseStatus(res, 200, "success", {
      pdfUrl: `/reports/pdf/${result.uuid}`,
      singleStudent: result.singleStudent,
      reportType: "result-sheet",
    });
  } catch (err) {
    return responseStatus(res, 500, "failed", err.message || "PDF generation failed");
  }
};

// POST /pdf-reports/analytics
exports.generateAnalytics = async (req, res) => {
  try {
    const { studentId, subjectId, fromDate, toDate } = req.body;
    const schoolName = process.env.SCHOOL_NAME || "School Portal";
    const result = await pdfReportService.generateAnalyticsPDF({ studentId, subjectId, fromDate, toDate }, schoolName);

    return responseStatus(res, 200, "success", {
      pdfUrl: `/reports/pdf/${result.uuid}`,
      singleStudent: result.singleStudent,
      reportType: "analytics",
    });
  } catch (err) {
    return responseStatus(res, 500, "failed", err.message || "PDF generation failed");
  }
};

// POST /pdf-reports/session-report
exports.generateSessionReport = async (req, res) => {
  try {
    const { sessionId, studentId } = req.body;
    if (!sessionId || !studentId) return responseStatus(res, 400, "failed", "sessionId and studentId are required");

    const schoolName = process.env.SCHOOL_NAME || "School Portal";
    const result = await pdfReportService.generateSessionReportPDF(sessionId, studentId, schoolName);

    return responseStatus(res, 200, "success", {
      pdfUrl: `/reports/pdf/${result.uuid}`,
      singleStudent: result.singleStudent,
      reportType: "session-report",
    });
  } catch (err) {
    return responseStatus(res, 500, "failed", err.message || "PDF generation failed");
  }
};

// GET /pdf-reports/:uuid — serve the PDF file
exports.servePdf = async (req, res) => {
  const filePath = pdfReportService.getPdfPath(req.params.uuid);
  if (!filePath) return res.status(404).send("PDF not found or expired");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="report-${req.params.uuid.slice(0, 8)}.pdf"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("error", () => res.status(500).send("Error reading PDF"));
};
