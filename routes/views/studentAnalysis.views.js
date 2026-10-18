const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");
const { THRESHOLDS } = require("../../services/alerts/atRiskAlerts.service");
const TestResult = require("../../models/Academic/testResult.model");

// Admin views any student's analysis
router.get("/students/:studentId/analysis", requireAdminOrManager(), async (req, res) => {
  const result = await apiFetch(`/students/${req.params.studentId}/analysis`, req.token);

  res.render("students/analysis", {
    page: "students",
    user: req.user,
    analysis: result.status === "success" ? result.data : null,
    alertThresholds: THRESHOLDS,
    loadError: result.status === "success" ? null : result.message,
    // Set when a POST /students/:id/send-report bounced back here (query is
    // EJS-escaped on render — the flash partial path is the repo's pattern).
    reportError: typeof req.query.reportError === "string" ? req.query.reportError : null,
    schoolName: res.locals.schoolName,
  });
});

// POST /students/:studentId/send-report — WhatsApp "Send report" button on the
// View Student page. Reuses the existing single-student session-report PDF
// generator (/pdf-reports/session-report, admin/manager-gated API-side) for the
// student's most RECENT session, then renders the shared "PDF Ready" page with a
// wa.me deep link carrying a summary + the absolute public UUID PDF URL — same
// message pattern as the bulk session-report share (buildBulkWhatsAppLink).
router.post("/students/:studentId/send-report", requireAdminOrManager(), async (req, res) => {
  const { studentId } = req.params;
  const backOnError = (msg) =>
    res.redirect(`/students/${studentId}/analysis?reportError=${encodeURIComponent(msg || "Failed to generate the report PDF")}`);

  // Latest session = the session behind the student's most recent scored test.
  // Date-derived (not session-list order) so it reflects what the student has
  // actually sat, and can't be spoofed via a form-injected sessionId.
  let latest = null;
  try {
    const results = await TestResult.find({ student: studentId })
      .populate({ path: "test", select: "date session", populate: { path: "session", select: "name" } })
      .lean();
    results.forEach((r) => {
      const t = r.test;
      if (!t || !t.session || !t.date) return;
      if (!latest || new Date(t.date) > new Date(latest.test.date)) latest = r;
    });
  } catch (err) {
    return backOnError(err.message || "Failed to look up the student's test results");
  }
  if (!latest) return backOnError("No session test results found for this student yet — nothing to report.");

  let gen;
  try {
    gen = await apiFetch("/pdf-reports/session-report", req.token, {
      method: "POST",
      body: JSON.stringify({ sessionId: latest.test.session._id, studentId }),
    });
  } catch (err) {
    return backOnError(err.message);
  }
  if (gen.status !== "success") return backOnError(gen.message);

  const { pdfUrl, singleStudent } = gen.data;

  // Summary figures — pulled through the same analysis service the page shows,
  // so the WhatsApp message can never disagree with the dashboard.
  const analysisRes = await apiFetch(`/students/${studentId}/analysis`, req.token);
  const a = analysisRes.status === "success" ? analysisRes.data : null;

  let whatsappLink = null;
  const phone = String(singleStudent && singleStudent.whatsapp || "").replace(/[^0-9]/g, "");
  if (phone && pdfUrl) {
    const absoluteUrl = `${req.protocol}://${req.get("host")}${pdfUrl}`;
    const schoolName = process.env.SCHOOL_NAME || "School Portal";
    const contactLine = process.env.INSTITUTE_WHATSAPP ? ` For queries, contact us on WhatsApp: ${process.env.INSTITUTE_WHATSAPP}` : "";
    const summary = [];
    if (a) {
      if (a.attendance.currentMonth.percent !== null) {
        summary.push(`attendance this month: ${a.attendance.currentMonth.percent}%`);
      } else if (a.attendance.percent !== null) {
        summary.push(`attendance: ${a.attendance.percent}%`);
      }
      if (a.marks.overallAverage !== null) summary.push(`overall test average: ${a.marks.overallAverage}%`);
    }
    const msg = encodeURIComponent(
      `Report card for ${singleStudent.name} (${latest.test.session.name})` +
      (summary.length ? ` — ${summary.join("; ")}` : "") +
      `. Full report: ${absoluteUrl}.${contactLine} — ${schoolName}`
    );
    whatsappLink = `https://wa.me/${phone}?text=${msg}`;
  }

  res.render("reports/result", {
    page: "reports",
    user: req.user,
    pdfUrl,
    whatsappLink,
    studentName: singleStudent ? singleStudent.name : null,
    reportType: "session-report",
    backUrl: `/students/${studentId}/analysis`,
    backLabel: "← Back to student",
    schoolName: res.locals.schoolName,
  });
});

// Student views their own analysis
router.get("/my/analysis", requireRole("student"), async (req, res) => {
  const result = await apiFetch(`/students/${req.user._id}/analysis`, req.token);

  res.render("students/analysis", {
    page: "my-analysis",
    user: req.user,
    analysis: result.status === "success" ? result.data : null,
    alertThresholds: THRESHOLDS,
    loadError: result.status === "success" ? null : result.message,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
