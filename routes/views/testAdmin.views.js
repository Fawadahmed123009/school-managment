const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");

// Sort sentinels: tests missing a session/phase/week sink to the bottom of
// their own group instead of mixing in with the categorised ones.
const SESSIONS_UNRANKED = 1e9;
const PHASES_UNRANKED = 1e9;
const WEEKS_UNRANKED = 8.64e15; // epoch-ms far in the future

router.get("/tests/manage", requireAdminOrManager(), async (req, res) => {
  const [testsRes, sessionsRes, subjectsRes, classesRes] = await Promise.all([
    apiFetch("/tests", req.token),
    apiFetch("/test-sessions", req.token),
    apiFetch("/subject", req.token),
    apiFetch("/class-levels", req.token),
  ]);

  const tests = testsRes.status === "success" ? testsRes.data : [];
  const sessions = sessionsRes.status === "success" ? sessionsRes.data : [];

  // `phase` on a test is a bare subdocument id (no ref), so its name and order
  // have to be resolved from the owning session's phases array.
  const phaseNames = {};
  const phaseOrder = {};
  sessions.forEach((s) => {
    (s.phases || []).forEach((p) => {
      phaseNames[p._id] = p.name;
      phaseOrder[p._id] = Number.isFinite(p.order) ? p.order : 0;
    });
  });

  // Group the ledger Session → Phase → Week → newest, so the list reads
  // categorically instead of as a flat date-sorted dump.
  const sessionRank = {};
  sessions.forEach((s, i) => {
    sessionRank[s._id] = i;
  });
  const rankSession = (t) =>
    t.session && sessionRank[t.session._id] !== undefined ? sessionRank[t.session._id] : SESSIONS_UNRANKED;
  const rankPhase = (t) =>
    t.phase && phaseOrder[t.phase] !== undefined ? phaseOrder[t.phase] : PHASES_UNRANKED;
  const rankWeek = (t) => (t.week && t.week.startDate ? new Date(t.week.startDate).getTime() : WEEKS_UNRANKED);

  tests.sort((a, b) => {
    if (rankSession(a) !== rankSession(b)) return rankSession(a) - rankSession(b);
    if (rankPhase(a) !== rankPhase(b)) return rankPhase(a) - rankPhase(b);
    if (rankWeek(a) !== rankWeek(b)) return rankWeek(a) - rankWeek(b);
    return new Date(b.date) - new Date(a.date);
  });

  res.render("tests/manage", {
    page: "tests-manage",
    user: req.user,
    ok: req.query.ok === "1",
    createError: req.query.error || null,
    tests,
    sessions,
    phaseNames,
    subjects: subjectsRes.status === "success" ? subjectsRes.data : [],
    classes: classesRes.status === "success" ? classesRes.data : [],
    loadError: testsRes.status === "success" ? null : testsRes.message,
    schoolName: res.locals.schoolName,
  });
});

router.post("/tests/create", requireAdminOrManager(), async (req, res) => {
  const { name, subject, classLevels, date, totalMarks, passMarks, session, phase, week } = req.body;

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
      week: week || null,
    }),
  });

  if (result.status !== "success") {
    return res.redirect(`/tests/manage?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect("/tests/manage?ok=1");
});

router.get("/sessions/manage", requireAdminOrManager(), async (req, res) => {
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

router.post("/sessions/create", requireAdminOrManager(), async (req, res) => {
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

router.post("/tests/:testId/delete", requireAdminOrManager(), async (req, res) => {
  const result = await apiFetch(`/tests/${req.params.testId}`, req.token, {
    method: "DELETE",
  });

  if (result.status !== "success") {
    return res.redirect(`/tests/manage?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect("/tests/manage?ok=1");
});

// Delete test session
router.post("/sessions/:sessionId/delete", requireAdminOrManager(), async (req, res) => {
  const result = await apiFetch(`/test-sessions/${req.params.sessionId}`, req.token, {
    method: "DELETE",
  });

  if (result.status !== "success") {
    return res.redirect(`/sessions/manage?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect("/sessions/manage?ok=1");
});

module.exports = router;
