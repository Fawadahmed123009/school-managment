const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");

router.get("/sessions/:sessionId/report", requireAdminOrManager(), async (req, res) => {
  const studentsRes = await apiFetch("/admin/students", req.token);

  res.render("tests/session-report-pick", {
    page: "sessions-manage",
    user: req.user,
    sessionId: req.params.sessionId,
    students: studentsRes.status === "success" ? (Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.data || []) : [],
    loadError: studentsRes.status === "success" ? null : studentsRes.message,
    schoolName: res.locals.schoolName,
  });
});

router.get("/sessions/:sessionId/report/:studentId", requireAdminOrManager(), async (req, res) => {
  const result = await apiFetch(`/test-sessions/${req.params.sessionId}/report/${req.params.studentId}`, req.token);
  const studentsRes = await apiFetch("/admin/students", req.token);
  const studentsList = studentsRes.status === "success" ? (Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.data || []) : [];
  const student = studentsList.find((s) => s._id.toString() === req.params.studentId.toString()) || null;

  res.render("tests/session-report", {
    page: "sessions-manage",
    user: req.user,
    sessionId: req.params.sessionId,
    studentId: req.params.studentId,
    studentName: student ? student.name : "Student",
    report: result.status === "success" ? result.data : null,
    loadError: result.status === "success" ? null : result.message,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
