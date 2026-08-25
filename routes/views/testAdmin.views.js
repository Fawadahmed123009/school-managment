const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

router.get("/tests/manage", requireRole("admin"), async (req, res) => {
  const [testsRes, sessionsRes, subjectsRes, classesRes] = await Promise.all([
    apiFetch("/tests", req.token),
    apiFetch("/test-sessions", req.token),
    apiFetch("/subject", req.token),
    apiFetch("/class-levels", req.token),
  ]);

  res.render("tests/manage", {
    page: "tests-manage",
    user: req.user,
    ok: req.query.ok === "1",
    createError: req.query.error || null,
    tests: testsRes.status === "success" ? testsRes.data : [],
    sessions: sessionsRes.status === "success" ? sessionsRes.data : [],
    subjects: subjectsRes.status === "success" ? subjectsRes.data : [],
    classes: classesRes.status === "success" ? classesRes.data : [],
    loadError: testsRes.status === "success" ? null : testsRes.message,
    schoolName: res.locals.schoolName,
  });
});

router.post("/tests/create", requireRole("admin"), async (req, res) => {
  const { name, subject, classLevels, date, totalMarks, passMarks, session, phase } = req.body;

  const result = await apiFetch("/tests", req.token, {
    method: "POST",
    body: JSON.stringify({
      name,
      subject,
      classLevels: Array.isArray(classLevels) ? classLevels : [classLevels],
      date,
      totalMarks: Number(totalMarks),
      passMarks: Number(passMarks),
      session: session || null,
      phase: phase || null,
    }),
  });

  if (result.status !== "success") {
    return res.redirect(`/tests/manage?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect("/tests/manage?ok=1");
});

router.get("/sessions/manage", requireRole("admin"), async (req, res) => {
  const [sessionsRes, classesRes] = await Promise.all([
    apiFetch("/test-sessions", req.token),
    apiFetch("/class-levels", req.token),
  ]);

  res.render("tests/sessions", {
    page: "sessions-manage",
    user: req.user,
    ok: req.query.ok === "1",
    createError: req.query.error || null,
    sessions: sessionsRes.status === "success" ? sessionsRes.data : [],
    classes: classesRes.status === "success" ? classesRes.data : [],
    loadError: sessionsRes.status === "success" ? null : sessionsRes.message,
    schoolName: res.locals.schoolName,
  });
});

router.post("/sessions/create", requireRole("admin"), async (req, res) => {
  const { name, classLevels, phaseNames } = req.body;

  const phases = (Array.isArray(phaseNames) ? phaseNames : [phaseNames])
    .filter((p) => p && p.trim())
    .map((p) => ({ name: p.trim() }));

  const result = await apiFetch("/test-sessions", req.token, {
    method: "POST",
    body: JSON.stringify({
      name,
      classLevels: Array.isArray(classLevels) ? classLevels : [classLevels],
      phases,
    }),
  });

  if (result.status !== "success") {
    return res.redirect(`/sessions/manage?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect("/sessions/manage?ok=1");
});

module.exports = router;
