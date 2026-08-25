const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

router.get("/assignments", requireRole("admin"), async (req, res) => {
  const [assignmentsRes, teachersRes, subjectsRes, classesRes] = await Promise.all([
    apiFetch("/assignments", req.token),
    apiFetch("/teachers", req.token),
    apiFetch("/subject", req.token),
    apiFetch("/class-levels", req.token),
  ]);

  res.render("assignments/list", {
    page: "assignments",
    user: req.user,
    ok: req.query.ok === "1",
    createError: req.query.error || null,
    assignments: assignmentsRes.status === "success" ? assignmentsRes.data : [],
    teachers: teachersRes.status === "success" ? (Array.isArray(teachersRes.data) ? teachersRes.data : teachersRes.data?.data || []) : [],
    subjects: subjectsRes.status === "success" ? subjectsRes.data : [],
    classes: classesRes.status === "success" ? classesRes.data : [],
    loadError: assignmentsRes.status === "success" ? null : assignmentsRes.message,
    schoolName: res.locals.schoolName,
  });
});

router.post("/assignments/create", requireRole("admin"), async (req, res) => {
  const { teacher, subject, classLevel } = req.body;
  const result = await apiFetch("/assignments", req.token, {
    method: "POST",
    body: JSON.stringify({ teacher, subject, classLevel }),
  });

  if (result.status !== "success") {
    return res.redirect(`/assignments?error=${encodeURIComponent(result.message)}`);
  }

  res.redirect("/assignments?ok=1");
});

router.post("/assignments/:assignmentId/delete", requireRole("admin"), async (req, res) => {
  await apiFetch(`/assignments/${req.params.assignmentId}`, req.token, { method: "DELETE" });
  res.redirect("/assignments?ok=1");
});

module.exports = router;
