const express = require("express");
const fs = require("fs");
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");
const pdfReportService = require("../../services/academic/pdfReport.service");

// ─── Public router (mounted BEFORE authView) ────────────────────────────────
// Serves generated PDFs by UUID — no auth required (UUID is the secret).
const publicRouter = express.Router();
publicRouter.get("/reports/pdf/:uuid", (req, res) => {
  const filePath = pdfReportService.getPdfPath(req.params.uuid);
  if (!filePath) return res.status(404).send("PDF not found or expired");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="report-${req.params.uuid.slice(0, 8)}.pdf"`);
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("error", () => res.status(500).send("Error reading PDF"));
});

// ─── Authenticated router (mounted AFTER authView) ──────────────────────────
const generateRouter = express.Router();

// GET /reports/generate — PDF generation form
generateRouter.get("/reports/generate", requireRole("admin", "teacher"), async (req, res) => {
  // Manager gets admin-scoped (unrestricted) access, not teacher-scoped
  const isTeacher = req.user.role === "teacher" && !req.user.isManager;

  const sessionsRes = await apiFetch("/test-sessions", req.token);
  const sessions = sessionsRes.status === "success" ? sessionsRes.data : [];

  let students = [], subjects = [], tests = [], teacherSubjects = null, teacherClasses = null;

  if (isTeacher) {
    // Teacher: only their assigned subjects/classes/tests
    const [assignmentsRes, testsRes] = await Promise.all([
      apiFetch("/assignments/my", req.token),
      apiFetch("/tests", req.token),
    ]);
    const assignments = assignmentsRes.status === "success" ? assignmentsRes.data : [];
    tests = testsRes.status === "success" ? testsRes.data : [];

    const subjectMap = {};
    const classMap = {};
    assignments.forEach((a) => {
      if (a.subject) subjectMap[a.subject._id] = a.subject.name;
      if (a.classLevel) classMap[a.classLevel._id] = a.classLevel.name;
    });
    teacherSubjects = Object.entries(subjectMap).map(([id, name]) => ({ _id: id, name }));
    teacherClasses = Object.entries(classMap).map(([id, name]) => ({ _id: id, name }));
    subjects = teacherSubjects;

    // Filter tests to only those in teacher's subjects
    tests = tests.filter((t) => {
      if (!t.subject) return false;
      const subId = typeof t.subject === "object" ? t.subject._id : t.subject;
      return subjectMap[subId] !== undefined;
    });

    // Students: get from classes the teacher is assigned to
    // Since /admin/students is admin-only, we leave the list empty for teachers
    // They can still use the analytics filter with student ID from other sources
    students = [];
  } else {
    // Admin: unrestricted
    const [studentsRes, subjectsRes, testsRes] = await Promise.all([
      apiFetch("/admin/students", req.token),
      apiFetch("/subject", req.token),
      apiFetch("/tests", req.token),
    ]);
    students = studentsRes.status === "success" ? (Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.data || []) : [];
    subjects = subjectsRes.status === "success" ? subjectsRes.data : [];
    tests = testsRes.status === "success" ? testsRes.data : [];
  }

  res.render("reports/generate", {
    page: "reports",
    user: req.user,
    students,
    subjects,
    tests,
    sessions,
    isTeacher,
    teacherSubjects,
    teacherClasses,
    schoolName: res.locals.schoolName,
  });
});

// POST /reports/generate — generate PDF and show result
generateRouter.post("/reports/generate", requireRole("admin", "teacher"), async (req, res) => {
  const { reportType, testId, studentId, subjectId, fromDate, toDate, sessionId } = req.body;

  let endpoint, body;
  if (reportType === "result-sheet") {
    endpoint = "/pdf-reports/result-sheet";
    body = { testId };
  } else if (reportType === "analytics") {
    endpoint = "/pdf-reports/analytics";
    body = { studentId: studentId || undefined, subjectId: subjectId || undefined, fromDate, toDate };
  } else if (reportType === "session-report") {
    endpoint = "/pdf-reports/session-report";
    body = { sessionId, studentId };
  } else {
    return res.redirect("/reports/generate?error=Invalid+report+type");
  }

  const result = await apiFetch(endpoint, req.token, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (result.status !== "success") {
    return res.redirect(`/reports/generate?error=${encodeURIComponent(result.message || "PDF generation failed")}`);
  }

  const { pdfUrl, singleStudent } = result.data;

  // Build WhatsApp share link (only for single student)
  let whatsappLink = null;
  if (singleStudent && singleStudent.whatsapp) {
    const phone = singleStudent.whatsapp.replace(/[^0-9]/g, "");
    const msg = encodeURIComponent(`Here is the report for ${singleStudent.name} — ${process.env.SCHOOL_NAME || "School Portal"}`);
    whatsappLink = `https://wa.me/${phone}?text=${msg}`;
  }

  res.render("reports/result", {
    page: "reports",
    user: req.user,
    pdfUrl,
    whatsappLink,
    studentName: singleStudent ? singleStudent.name : null,
    reportType,
    schoolName: res.locals.schoolName,
  });
});

module.exports = { publicRouter, generateRouter };
