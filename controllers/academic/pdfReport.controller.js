const fs = require("fs");
const pdfReportService = require("../../services/academic/pdfReport.service");
const responseStatus = require("../../handlers/responseStatus.handler");
const Test = require("../../models/Academic/test.model");
const Assignment = require("../../models/Academic/assignment.model");
const Student = require("../../models/Students/students.model");
const ClassLevel = require("../../models/Academic/class.model");
const Admin = require("../../models/Staff/admin.model");
const Teacher = require("../../models/Staff/teachers.model");
const TestSession = require("../../models/Academic/testSession.model");

// Hard cap for one bulk run — a report card is a multi-section PDF, so an
// unscoped school-wide batch would wedge the request thread for minutes.
const BULK_STUDENT_CAP = 300;

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const sanitizeIds = (value) =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .map((v) => String(v))
    .filter((v) => OBJECT_ID_RE.test(v));

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

// Result-sheet category scoping: the form's Grade/Section pickers may also
// narrow which pupils appear in the PDF. Values are whitelisted (they only
// ever string-compare against class metadata downstream, but keep the API
// surface tight). "none" is the no-grade/no-section bucket; an empty value
// means no narrowing.
const GRADE_RE = /^(PG|[1-9]|1[0-2])$/;
const SECTION_VALUES = ["Boys", "Girls", "none"];

// POST /pdf-reports/result-sheet
exports.generateResultSheet = async (req, res) => {
  try {
    const { testId } = req.body;
    if (!testId) return responseStatus(res, 400, "failed", "testId is required");

    const rawGrade = String(req.body.grade || "");
    const grade = rawGrade === "none" || GRADE_RE.test(rawGrade) ? rawGrade : undefined;
    const section = SECTION_VALUES.includes(req.body.section) ? req.body.section : undefined;

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
    const result = await pdfReportService.generateResultSheetPDF(testId, schoolName, { grade, section });

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
    const { studentId, subjectId } = req.body;

    // Period scope (mirrors the session-report picker): the analytics PDF picks
    // its layout mode from how wide the period is — one week → flat list,
    // phase → per-test subject groups, 2+ weeks → per-week subject groups.
    // Only well-formed ObjectIds survive; everything else falls through as
    // unset (legacy unscoped report).
    const period = {
      sessionId: sanitizeIds(req.body.sessionId)[0],
      phaseId: sanitizeIds(req.body.phaseId)[0],
      weekId: sanitizeIds(req.body.weekId)[0],
      weekIds: sanitizeIds(req.body.weekIds),
    };
    if (!period.weekIds.length) delete period.weekIds;

    // Grade / Section scope which pupils appear (same whitelisted values the
    // result sheet accepts); testId narrows the report to a single test. All are
    // optional — an empty value means no narrowing.
    const rawGrade = String(req.body.grade || "");
    const grade = rawGrade === "none" || GRADE_RE.test(rawGrade) ? rawGrade : undefined;
    const section = SECTION_VALUES.includes(req.body.section) ? req.body.section : undefined;
    const analyticsTestId = sanitizeIds(req.body.testId)[0];

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
    const result = await pdfReportService.generateAnalyticsPDF({ studentId, subjectId, period, grade, section, testId: analyticsTestId }, schoolName, scope);

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
    const { sessionId, studentId, phaseId, weekId } = req.body;
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
    const weekIds = sanitizeIds(req.body.weekIds);
    const period = { phaseId: phaseId || undefined, weekId: weekId || undefined, weekIds: weekIds.length ? weekIds : undefined };
    const result = await pdfReportService.generateSessionReportPDF(sessionId, studentId, schoolName, period);

    return responseStatus(res, 200, "success", {
      pdfUrl: `/reports/pdf/${result.uuid}`,
      singleStudent: result.singleStudent,
      reportType: "session-report",
    });
  } catch (err) {
    return responseStatus(res, 500, "failed", err.message || "PDF generation failed");
  }
};

// POST /pdf-reports/session-report-bulk
// Session report cards for a whole class or a set of selected sections,
// optionally narrowed to one phase or one week. Same admin/manager gate as
// the single-student twin (Finding B-1): the payload is the full parent-
// facing report card, so no teacher scoping is attempted — it is simply 403.
exports.generateSessionReportBulk = async (req, res) => {
  try {
    const { sessionId, scope, classLevelId, classLevelIds, phaseId, weekId, weekIds: rawWeekIds } = req.body;
    if (!sessionId || !OBJECT_ID_RE.test(String(sessionId))) {
      return responseStatus(res, 400, "failed", "A valid sessionId is required");
    }

    const caller = await resolveCaller(req);
    if (caller.restricted) {
      return responseStatus(res, 403, "failed", "Only admins and managers can generate session report cards");
    }

    // "class" = one ClassLevel (whole class), "sections" = several ClassLevels
    // (the class-section combos picked from the grouped checkbox list).
    const ids = scope === "class" ? sanitizeIds(classLevelId) : scope === "sections" ? sanitizeIds(classLevelIds) : [];
    if (ids.length === 0) {
      return responseStatus(res, 400, "failed", "Select at least one class or section");
    }

    const session = await TestSession.findById(sessionId).select("_id").lean();
    if (!session) return responseStatus(res, 404, "failed", "Session not found");

    // Only currently-enrolled students get report cards.
    const students = await Student.find({
      classLevel: { $in: ids },
      status: "active",
      isWithdrawn: false,
      isGraduated: false,
    })
      .select("_id")
      .lean();

    if (students.length === 0) {
      return responseStatus(res, 400, "failed", "No active students in the selected class/es");
    }
    if (students.length > BULK_STUDENT_CAP) {
      return responseStatus(res, 400, "failed", `Bulk generation supports up to ${BULK_STUDENT_CAP} students at a time (selected class/es have ${students.length})`);
    }

    const schoolName = process.env.SCHOOL_NAME || "School Portal";
    const weekIds = sanitizeIds(rawWeekIds);
    const reports = await pdfReportService.generateSessionReportBulkPDFs(
      { sessionId, studentIds: students.map((s) => s._id), phaseId: phaseId || undefined, weekId: weekId || undefined, weekIds: weekIds.length ? weekIds : undefined },
      schoolName
    );

    const generatedCount = reports.filter((r) => r.status === "generated").length;
    return responseStatus(res, 200, "success", {
      reports,
      generatedCount,
      skippedCount: reports.length - generatedCount,
      reportType: "session-report-bulk",
    });
  } catch (err) {
    return responseStatus(res, 500, "failed", err.message || "PDF generation failed");
  }
};

// GET /pdf-reports/session-students?sessionId=...
// Feature 1: the session-report student picker must list only the students who
// are actually in scope for the chosen session — i.e. those whose classLevel is
// covered by at least one test in that session — rather than every student
// school-wide. Derived from Test.classLevels (the sections a session's tests
// target) intersected with the currently-enrolled roster, mirroring the same
// active/enrolled guard the bulk generator uses.
// Same admin/manager gate as the report it feeds (Finding B-1).
exports.getSessionScopedStudents = async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId || !OBJECT_ID_RE.test(String(sessionId))) {
      return responseStatus(res, 400, "failed", "A valid sessionId is required");
    }

    const caller = await resolveCaller(req);
    if (caller.restricted) {
      return responseStatus(res, 403, "failed", "Only admins and managers can generate session report cards");
    }

    // Sections covered by at least one test in this session.
    const classLevelIds = await Test.distinct("classLevels", { session: sessionId });
    if (!classLevelIds || classLevelIds.length === 0) {
      return responseStatus(res, 200, "success", { students: [], classes: [] });
    }

    const [students, coveredClasses] = await Promise.all([
      Student.find({
        classLevel: { $in: classLevelIds },
        status: "active",
        isWithdrawn: false,
        isGraduated: false,
      })
        .select("name rollNumber classLevel parent")
        .populate("classLevel", "gradeLevel section sectionRef")
        .populate("parent", "name")
        .sort("rollNumber name")
        .lean(),
      // The classes themselves, scoped to the session — the "whole grade" and
      // "selected sections" pickers list grades/sections ONLY from here so a
      // session's grade options never leak unrelated grades.
      ClassLevel.find({ _id: { $in: classLevelIds } })
        .select("name gradeLevel group section sectionRef")
        .populate("sectionRef", "name")
        .sort("gradeLevel name")
        .lean(),
    ]);

    const shapeClass = (c) => ({
      _id: String(c._id),
      gradeLevel: c.gradeLevel || null,
      section: (c.sectionRef && c.sectionRef.name) || c.section || null,
      name: c.name,
      group: c.group || null,
    });

    // Carry the class metadata (grade, Boys/Girls section) and the parent name
    // so the report form can cascade Grade → Section → Student and search by
    // name / roll number entirely client-side. Section falls back to the legacy
    // `section` field for pre-migration rows, matching the view's class picker.
    return responseStatus(res, 200, "success", {
      students: students.map((s) => {
        const cl = s.classLevel || {};
        const section = (cl.sectionRef && cl.sectionRef.name) || cl.section || null;
        return {
          _id: s._id,
          name: s.name,
          rollNumber: s.rollNumber,
          grade: cl.gradeLevel || null,
          section,
          parentName: s.parent && s.parent.name ? s.parent.name : null,
        };
      }),
      classes: coveredClasses.map(shapeClass),
    });
  } catch (err) {
    return responseStatus(res, 500, "failed", err.message || "Could not load session students");
  }
};

// GET /pdf-reports/teacher-students
// One shared student source for every PDF report filter cascade (Result Sheet,
// Session Report Card, Analytics) — all three panels are populated/scoped the
// same way, so the pickers can never drift apart per report.
//   • admin / manager → the whole roster (grade + section resolved from each
//     pupil's own class).
//   • plain teacher   → only students in the classes they are assigned to
//     (Assignment-derived, same DB-resolved identity as every other gate here
//     — token claims are never trusted), restricted to the currently-enrolled
//     roster like the other teacher-facing scopes.
// The list is deliberately NOT paginated (the /admin/students twin caps at 20)
// — the picker must offer every in-scope pupil.
exports.getTeacherScopedStudents = async (req, res) => {
  try {
    const caller = await resolveCaller(req);

    let filter = {};
    if (caller.restricted) {
      const assignments = await Assignment.find({ teacher: caller.teacherId }).select("classLevel").lean();
      const classIds = [...new Set(assignments.filter((a) => a.classLevel).map((a) => String(a.classLevel)))];
      if (classIds.length === 0) return responseStatus(res, 200, "success", { students: [] });
      filter = { classLevel: { $in: classIds }, status: "active", isWithdrawn: false, isGraduated: false };
    }

    const students = await Student.find(filter)
      .select("name rollNumber classLevel")
      .populate("classLevel", "gradeLevel section sectionRef")
      .sort("name")
      .lean();

    // Section resolves the same way as everywhere else on the report form
    // (sectionRef name preferred, legacy `section` fallback for pre-migration
    // rows) so client-side Grade → Section narrowing matches server-side scope.
    // classLevelId keys the session funnel: the shared cascade links a pupil to
    // the classes a session's tests cover (Test.classLevels) purely client-side,
    // so Session → Grade → Section → Student narrowing works for every role
    // without a per-session round-trip.
    return responseStatus(res, 200, "success", {
      students: students.map((s) => {
        const cl = s.classLevel || {};
        return {
          _id: s._id,
          name: s.name,
          rollNumber: s.rollNumber,
          grade: cl.gradeLevel || null,
          section: (cl.sectionRef && cl.sectionRef.name) || cl.section || null,
          classLevelId: cl._id ? String(cl._id) : null,
        };
      }),
    });
  } catch (err) {
    return responseStatus(res, 500, "failed", err.message || "Could not load scoped students");
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
