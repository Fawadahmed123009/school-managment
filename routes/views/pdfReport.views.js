const express = require("express");
const fs = require("fs");
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");
const pdfReportService = require("../../services/academic/pdfReport.service");
const { buildSessionIndex, sortTestsByCategory } = require("../../utils/testCategoryIndex");
const TestSession = require("../../models/Academic/testSession.model");
const Week = require("../../models/Academic/week.model");

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

// wa.me deep link for one report. Unlike the single-report share link (which
// pre-dates the bulk flow and just tees up the chat), bulk links must carry
// the absolute PDF URL — the sender opens dozens of chats and cannot attach
// each file by hand.
function buildBulkWhatsAppLink(req, { name, whatsapp }, pdfUrl) {
  const phone = String(whatsapp || "").replace(/[^0-9]/g, "");
  if (!phone || !pdfUrl) return null;
  const absoluteUrl = `${req.protocol}://${req.get("host")}${pdfUrl}`;
  const contactLine = process.env.INSTITUTE_WHATSAPP ? ` For queries, contact us on WhatsApp: ${process.env.INSTITUTE_WHATSAPP}` : "";
  const msg = encodeURIComponent(`Here is the session report for ${name} — ${process.env.SCHOOL_NAME || "School Portal"}: ${absoluteUrl}${contactLine}`);
  return `https://wa.me/${phone}?text=${msg}`;
}

// GET /reports/generate — PDF generation form
generateRouter.get("/reports/generate", requireRole("admin", "teacher"), async (req, res) => {
  // Manager gets admin-scoped (unrestricted) access, not teacher-scoped
  const isTeacher = req.user.role === "teacher" && !req.user.isManager;

  const sessionsRes = await apiFetch("/test-sessions", req.token);
  const sessions = sessionsRes.status === "success" ? sessionsRes.data : [];

  // Shared role-scoped student list feeding all three filter cascades:
  // admin/manager get the whole roster, a plain teacher only the students of
  // their assigned classes (resolved server-side from Assignments).
  const studentsRes = await apiFetch("/pdf-reports/teacher-students", req.token);
  const students = studentsRes.status === "success" ? studentsRes.data.students || [] : [];

  let subjects = [], tests = [], teacherSubjects = null, teacherClasses = null;

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
      if (a.subject) subjectMap[a.subject._id] = a.subject.displayName || a.subject.name;
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
  } else {
    // Admin: unrestricted
    const [subjectsRes, testsRes] = await Promise.all([
      apiFetch("/subject", req.token),
      apiFetch("/tests", req.token),
    ]);
    subjects = subjectsRes.status === "success" ? subjectsRes.data : [];
    tests = testsRes.status === "success" ? testsRes.data : [];
  }

  // Result-sheet picker: newest tests first.
  const { sessionRank, phaseOrder } = await buildSessionIndex(tests, sessions);
  sortTestsByCategory(tests, sessionRank, phaseOrder);

  // Class-scope map for the session→grade/section→test narrowing. Each test
  // targets one or more ClassLevels (Test.classLevels); the shared cascade needs
  // the grade + section behind every referenced class so it can (a) list only the
  // grades/sections a chosen session's tests actually cover and (b) drop tests
  // that don't touch the picked grade/section. Built from the already role-scoped
  // tests, so a teacher only ever sees classes within their assignments.
  const ClassLevel = require("../../models/Academic/class.model");
  const referencedClassIds = new Set();
  tests.forEach((t) => (t.classLevels || []).forEach((cl) => {
    const id = cl && cl._id ? cl._id : cl;
    if (id) referencedClassIds.add(id);
  }));
  const classScope = {};
  if (referencedClassIds.size > 0) {
    const classes = await ClassLevel.find({ _id: { $in: [...referencedClassIds] } })
      .select("gradeLevel section sectionRef")
      .populate("sectionRef", "name")
      .lean();
    classes.forEach((c) => {
      classScope[String(c._id)] = {
        grade: c.gradeLevel || null,
        section: (c.sectionRef && c.sectionRef.name) || c.section || null,
      };
    });
  }

  // Session-report weeks for the period picker (cascaded client-side).
  // Read-only metadata at the same exposure level as the session/phase
  // index already handed to teachers.
  const weeks = sessions.length > 0
    ? await Week.find({ session: { $in: sessions.map((s) => s._id) } }).select("name phase session startDate").sort("startDate").lean()
    : [];

  res.render("reports/generate", {
    page: "reports",
    user: req.user,
    students,
    subjects,
    tests,
    sessions,
    weeks,
    classScope,
    isTeacher,
    teacherSubjects,
    teacherClasses,
    schoolName: res.locals.schoolName,
  });
});

// POST /reports/generate — generate PDF and show result
generateRouter.post("/reports/generate", requireRole("admin", "teacher"), async (req, res) => {
  const { reportType } = req.body;

  // Session report: three scopes share one picker panel — one student
  // (existing single flow), a whole class, or selected sections (bulk).
  if (reportType === "session-report") {
    // The unified cascade submits `sessionReport*`-prefixed names (all three
    // panels share one <form>; hidden ≠ unsubmitted). Only Session + Student
    // feed this report's endpoints — the backend is unchanged.
    const sessionId = req.body.sessionReportSessionId;
    const studentId = req.body.sessionReportStudentId;
    const scope = req.body.scope || "student";
    // Multi-week mode submits weekIds[] (checkbox array); a single week submits
    // weekId, a phase submits phaseId. Normalise weekIds to an array so a lone
    // ticked week (browser sends a string, not an array) still filters correctly.
    const rawWeekIds = req.body.weekIds;
    const weekIds = Array.isArray(rawWeekIds) ? rawWeekIds.filter(Boolean) : rawWeekIds ? [rawWeekIds] : [];
    const period = {
      phaseId: req.body.phaseId || undefined,
      weekId: req.body.weekId || undefined,
      weekIds: weekIds.length ? weekIds : undefined,
    };

    if (scope === "class" || scope === "sections") {
      const bulkRes = await apiFetch("/pdf-reports/session-report-bulk", req.token, {
        method: "POST",
        body: JSON.stringify({
          sessionId,
          scope,
          classLevelId: req.body.classLevelId,
          classLevelIds: req.body.classLevelIds,
          phaseId: period.phaseId,
          weekId: period.weekId,
          weekIds: period.weekIds,
        }),
      });
      if (bulkRes.status !== "success") {
        return res.redirect(`/reports/generate?error=${encodeURIComponent(bulkRes.message || "PDF generation failed")}`);
      }

      const session = await TestSession.findById(sessionId).select("name").lean();
      const reports = (bulkRes.data.reports || []).map((r) => ({
        ...r,
        waLink: r.status === "generated" ? buildBulkWhatsAppLink(req, r, r.pdfUrl) : null,
      }));

      return res.render("reports/bulk-result", {
        page: "reports",
        user: req.user,
        sessionName: session ? session.name : "",
        reports,
        generatedCount: bulkRes.data.generatedCount,
        skippedCount: bulkRes.data.skippedCount,
        schoolName: res.locals.schoolName,
      });
    }

    const singleRes = await apiFetch("/pdf-reports/session-report", req.token, {
      method: "POST",
      body: JSON.stringify({ sessionId, studentId, phaseId: period.phaseId, weekId: period.weekId, weekIds: period.weekIds }),
    });
    if (singleRes.status !== "success") {
      return res.redirect(`/reports/generate?error=${encodeURIComponent(singleRes.message || "PDF generation failed")}`);
    }
    const { pdfUrl, singleStudent } = singleRes.data;

    // Build WhatsApp share link (only for single student)
    let whatsappLink = null;
    if (singleStudent && singleStudent.whatsapp) {
      const phone = singleStudent.whatsapp.replace(/[^0-9]/g, "");
      const contactLine = process.env.INSTITUTE_WHATSAPP ? ` For queries, contact us on WhatsApp: ${process.env.INSTITUTE_WHATSAPP}` : "";
      const msg = encodeURIComponent(`Here is the report for ${singleStudent.name} — ${process.env.SCHOOL_NAME || "School Portal"}${contactLine}`);
      whatsappLink = `https://wa.me/${phone}?text=${msg}`;
    }

    return res.render("reports/result", {
      page: "reports",
      user: req.user,
      pdfUrl,
      whatsappLink,
      studentName: singleStudent ? singleStudent.name : null,
      reportType,
      schoolName: res.locals.schoolName,
    });
  }

  let endpoint, body;
  if (reportType === "result-sheet") {
    // A result sheet is scoped to exactly one test; grade/section come from the
    // unified cascade's pupil funnel and narrow which pupils the sheet lists.
    // Session/Subject/Student only drive the picker cascade — the generator's
    // contract (testId + grade + section) is unchanged.
    endpoint = "/pdf-reports/result-sheet";
    body = {
      testId: req.body.resultSheetTestId || undefined,
      grade: req.body.resultSheetGrade || undefined,
      section: req.body.resultSheetSection || undefined,
    };
  } else if (reportType === "analytics") {
    endpoint = "/pdf-reports/analytics";
    // Analytics has its own `analytics*`-prefixed field names so it never
    // collides with the other panels — all three panels live in one <form>,
    // and a hidden (display:none) input is still submitted, so any shared name
    // would double-post and poison the sibling panel's values. The picker is a
    // Session → Grade → Section → Student → Subject → Test cascade: session and
    // subject/test bound which tests feed the report, grade/section/student scope
    // which pupils appear. Every field is optional ("All …" = no narrowing).
    body = {
      studentId: req.body.analyticsStudentId || undefined,
      subjectId: req.body.analyticsSubjectId || undefined,
      sessionId: req.body.analyticsSessionId || undefined,
      grade: req.body.analyticsGrade || undefined,
      section: req.body.analyticsSection || undefined,
      testId: req.body.analyticsTestId || undefined,
    };
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
    const contactLine = process.env.INSTITUTE_WHATSAPP ? ` For queries, contact us on WhatsApp: ${process.env.INSTITUTE_WHATSAPP}` : "";
    const msg = encodeURIComponent(`Here is the report for ${singleStudent.name} — ${process.env.SCHOOL_NAME || "School Portal"}${contactLine}`);
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
