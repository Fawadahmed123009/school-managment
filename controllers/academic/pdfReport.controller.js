const fs = require("fs");
const pdfReportService = require("../../services/academic/pdfReport.service");
const responseStatus = require("../../handlers/responseStatus.handler");
const Test = require("../../models/Academic/test.model");
const Assignment = require("../../models/Academic/assignment.model");
const Student = require("../../models/Students/students.model");

// Helper: check if a teacher is assigned to a subject for any of the given class levels.
// Returns true for admins/managers (they bypass assignment scoping).
async function teacherCanAccessTest(teacherId, role, isManager, test) {
  if (role === "admin" || isManager) return true;
  const classLevelIds = (test.classLevels || []).map((cl) => cl._id || cl);
  if (classLevelIds.length === 0) return false;
  const assignment = await Assignment.findOne({
    teacher: teacherId,
    subject: test.subject._id || test.subject,
    classLevel: { $in: classLevelIds },
  });
  return !!assignment;
}

// POST /pdf-reports/result-sheet
exports.generateResultSheet = async (req, res) => {
  try {
    const { testId } = req.body;
    if (!testId) return responseStatus(res, 400, "failed", "testId is required");

    // Finding 1.1: verify teacher is assigned to this test's subject/class
    const test = await Test.findById(testId).populate("subject", "name").populate("classLevels", "name");
    if (!test) return responseStatus(res, 404, "failed", "Test not found");

    const isTeacher = req.userAuth.role === "teacher";
    const isManager = req.userAuth.isManager;
    if (isTeacher && !isManager) {
      const allowed = await teacherCanAccessTest(req.userAuth.id, req.userAuth.role, isManager, test);
      if (!allowed) {
        return responseStatus(res, 403, "failed", "You are not assigned to this subject/class for this test");
      }
    }

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

    // Finding 2.2: verify teacher is assigned to the requested subject and
    // teaches the requested student (if specified). Admins/managers bypass.
    const isTeacher = req.userAuth.role === "teacher";
    const isManager = req.userAuth.isManager;
    if (isTeacher && !isManager) {
      const teacherId = req.userAuth.id;
      const assignments = await Assignment.find({ teacher: teacherId }).select("subject classLevel").lean();
      const teacherSubjectIds = [...new Set(assignments.map((a) => a.subject.toString()))];
      const teacherClassIds = [...new Set(assignments.map((a) => a.classLevel.toString()))];

      // Validate subjectId is in the teacher's assignment set
      if (subjectId && !teacherSubjectIds.includes(subjectId)) {
        return responseStatus(res, 403, "failed", "You are not assigned to this subject");
      }

      // Validate studentId belongs to a class the teacher teaches
      if (studentId) {
        const student = await Student.findById(studentId).select("classLevel").lean();
        if (!student) return responseStatus(res, 404, "failed", "Student not found");
        const studentClassId = student.classLevel ? student.classLevel.toString() : null;
        if (!studentClassId || !teacherClassIds.includes(studentClassId)) {
          return responseStatus(res, 403, "failed", "You are not assigned to teach this student");
        }
      }

      // If no subjectId specified, teacher can only see their own subjects' data
      // (the service will filter by subjectId; we ensure at least one assignment exists)
      if (!subjectId && assignments.length === 0) {
        return responseStatus(res, 403, "failed", "You have no subject assignments");
      }
    }

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
