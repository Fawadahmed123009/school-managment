const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

router.get("/tests/analytics", requireRole("admin"), async (req, res) => {
  const { studentId, subjectId, fromDate, toDate } = req.query;

  const [studentsRes, subjectsRes] = await Promise.all([
    apiFetch("/admin/students", req.token),
    apiFetch("/subject", req.token),
  ]);

  const params = new URLSearchParams();
  if (studentId) params.set("studentId", studentId);
  if (subjectId) params.set("subjectId", subjectId);
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);

  const hasFilters = studentId || subjectId || fromDate || toDate;
  const analyticsRes = hasFilters
    ? await apiFetch(`/tests/analytics?${params.toString()}`, req.token)
    : { status: "success", data: [] };

  res.render("tests/analytics", {
    page: "tests-analytics",
    user: req.user,
    students: studentsRes.status === "success" ? (Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.data || []) : [],
    subjects: subjectsRes.status === "success" ? subjectsRes.data : [],
    results: analyticsRes.status === "success" ? analyticsRes.data : [],
    loadError: analyticsRes.status === "success" ? null : analyticsRes.message,
    filters: { studentId, subjectId, fromDate, toDate },
    hasFilters,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
