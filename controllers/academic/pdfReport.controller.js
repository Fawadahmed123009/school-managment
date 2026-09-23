const fs = require("fs");
const pdfReportService = require("../../services/academic/pdfReport.service");
const responseStatus = require("../../handlers/responseStatus.handler");
const Test = require("../../models/Academic/test.model");
const Assignment = require("../../models/Academic/assignment.model");
const Student = require("../../models/Students/students.model");
const Admin = require("../../models/Staff/admin.model");
const Teacher = require("../../models/Staff/teachers.model");

// Resolve whether the caller must be teacher-scoped.
// IMPORTANT: the API Bearer token only carries { id } (see
// utils/tokenGenerator.js), so req.userAuth.role / req.userAuth.isManager are
// undefined on real API requests — any access control that trusts them is
// silently bypassed. Identity MUST therefore be derived from the database,
// exactly like the isAdminOrManager / isAdminOrTeacher middlewares do.
// Admins and managers (teachers with isAttendanceManager) are unrestricted;
// everyone else (a plain teacher, or an unknown caller) must be scoped.
async function resolveCaller(req) {
  const auth = req.userAuth || {};
  const id = auth.id;
  // Honor an identity that a trusted layer already attached, if present.
  if (auth.role === "admin" || auth.isManager) return { restricted: false, teacherId: id };
  const admin = await Admin.findById(id).select("role").lean();
  if (admin && admin.role === "admin") return { restricted: false, teacherId: id };
  const teacher = await Teacher.findById(id).select("isAttendanceManager").lean();
  if (teacher && teacher.isAttendanceManager) return { restricted: false, teacherId: id };
  return { restricted: true, teacherId: id };
}

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

    const caller = await resolveCaller(req);
    if (caller.restricted) {
      const allowed = await teacherCanAccessTest(caller.teacherId, "teacher", false, test);
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

    // Finding A-1: a teacher may only see analytics that fall inside their own
    // (subject × classLevel) assignments — the same scoping reference used by
    // getTeacherAnalyticsService. Merely checking "does the teacher have at
    // least one assignment" is NOT enough: every filter combination must be
    // constrained, otherwise omitting subjectId (or studentId) leaks school-
    // wide / cross-class data through gatherAnalytics. We therefore derive a
    // scope from the assignments and hand it to the service, which MUST apply
    // it to the query. Admins/managers bypass.
    const caller = await resolveCaller(req);
    let scope = null;
    if (caller.restricted) {
      const teacherId = caller.teacherId;
      const assignments = await Assignment.find({ teacher: teacherId }).select("subject classLevel").lean();

      // Build subjectId -> Set(classLevelId) map (mirrors getTeacherAnalyticsService).
      const subjectClassMap = {};
      assignments.forEach((a) => {
        const subId = a.subject.toString();
        if (!subjectClassMap[subId]) subjectClassMap[subId] = new Set();
        subjectClassMap[subId].add(a.classLevel.toString());
      });
      const teacherSubjectIds = Object.keys(subjectClassMap);

      if (teacherSubjectIds.length === 0) {
        return responseStatus(res, 403, "failed", "You have no subject assignments");
      }

      // A specifically requested subject must be one the teacher teaches.
      if (subjectId && !teacherSubjectIds.includes(subjectId.toString())) {
        return responseStatus(res, 403, "failed", "You are not assigned to this subject");
      }

      // A specifically requested student's class must be one the teacher is
      // assigned to — for the requested subject, or for at least one of the
      // teacher's subjects when no subject was specified.
      if (studentId) {
        const student = await Student.findById(studentId).select("classLevel").lean();
        if (!student) return responseStatus(res, 404, "failed", "Student not found");
        const studentClassId = student.classLevel ? student.classLevel.toString() : null;
        const candidateSubjects = subjectId ? [subjectId.toString()] : teacherSubjectIds;
        const canSee =
          studentClassId &&
          candidateSubjects.some((sid) => subjectClassMap[sid] && subjectClassMap[sid].has(studentClassId));
        if (!canSee) {
          return responseStatus(res, 403, "failed", "You are not assigned to teach this student");
        }
      }

      // Constrain the service query to the teacher's assignment intersection.
      scope = { subjectClassMap, teacherSubjectIds };
    }

    const schoolName = process.env.SCHOOL_NAME || "School Portal";
    const result = await pdfReportService.generateAnalyticsPDF({ studentId, subjectId, fromDate, toDate }, schoolName, scope);

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

    // Finding B-1: the session report is a full per-student report card that
    // exposes photo, roll number, father's name, WhatsApp number and every
    // subject score in the session. A partial "teacher is assigned to at least
    // one subject in the session" check would still leak all the *other*
    // subjects' scores, so it is not a clean fit here. We gate this endpoint to
    // admin/manager, matching the JSON-API twin
    // GET /test-sessions/:sessionId/report/:studentId (isAdminOrManager).
    const caller = await resolveCaller(req);
    if (caller.restricted) {
      return responseStatus(res, 403, "failed", "Only admins and managers can generate session report cards");
    }

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
