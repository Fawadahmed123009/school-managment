const express = require("express");
const router = express.Router();
const { requireAdminOrManager } = require("../../middlewares/authView");
const { apiFetch } = require("../../utils/apiClient");
const {
  getWeeksForSessionService,
  getWeekByIdService,
  createWeekService,
  updateWeekService,
  deleteWeekService,
  buildCloneWeekPreviewService,
  executeCloneWeekService,
  getCloneFormContextService,
} = require("../../services/academic/week.service");
const { deletePhaseService, addPhaseService } = require("../../services/academic/testSession.service");
const TestSession = require("../../models/Academic/testSession.model");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");

// Week list for a specific session
router.get("/sessions/:sessionId/weeks", requireAdminOrManager(), async (req, res) => {
  try {
    const result = await getWeeksForSessionService(req.params.sessionId);
    if (!result) return res.redirect("/sessions/manage?error=" + encodeURIComponent("Session not found"));
    res.render("weeks/list", {
      page: "sessions-manage",
      user: req.user,
      ok: req.query.ok === "1",
      okMsg: req.query.msg || null,
      createError: req.query.error || null,
      session: result.session,
      weeks: result.weeks,
      loadError: null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect("/sessions/manage?error=" + encodeURIComponent(err.message));
  }
});

// Edit week form
router.get("/sessions/:sessionId/weeks/:weekId/edit", requireAdminOrManager(), async (req, res) => {
  try {
    const [week, session] = await Promise.all([
      getWeekByIdService(req.params.weekId),
      TestSession.findById(req.params.sessionId).lean(),
    ]);
    if (!week || !session) return res.redirect("/sessions/manage?error=" + encodeURIComponent("Week or session not found"));
    res.render("weeks/edit", {
      page: "sessions-manage",
      user: req.user,
      week,
      session,
      saveError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(err.message));
  }
});

// Create week
router.post("/sessions/:sessionId/weeks/create", requireAdminOrManager(), async (req, res) => {
  const { name, phase, startDate, endDate } = req.body;
  const { res: cap, result } = captureServiceResponse();
  try {
    await createWeekService({ name, session: req.params.sessionId, phase, startDate, endDate }, req.user._id, cap);
  } catch (err) {
    return res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(err.message || "Failed to create week"));
  }
  if (result.ok) return res.redirect("/sessions/" + req.params.sessionId + "/weeks?ok=1");
  return res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(result.message || "Failed to create week"));
});

// Update week
router.post("/sessions/:sessionId/weeks/:weekId/edit", requireAdminOrManager(), async (req, res) => {
  const { name, phase, startDate, endDate } = req.body;
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateWeekService({ name, session: req.params.sessionId, phase, startDate, endDate }, req.params.weekId, req.user._id, cap);
  } catch (err) {
    return res.redirect("/sessions/" + req.params.sessionId + "/weeks/" + req.params.weekId + "/edit?error=" + encodeURIComponent(err.message || "Update failed"));
  }
  if (result.ok) return res.redirect("/sessions/" + req.params.sessionId + "/weeks?ok=1");
  return res.redirect("/sessions/" + req.params.sessionId + "/weeks/" + req.params.weekId + "/edit?error=" + encodeURIComponent(result.message || "Update failed"));
});

// Delete week
router.post("/sessions/:sessionId/weeks/:weekId/delete", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await deleteWeekService(req.params.weekId, cap);
  } catch (err) {
    return res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(err.message || "Delete failed"));
  }
  if (result.ok) return res.redirect("/sessions/" + req.params.sessionId + "/weeks?ok=1");
  return res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(result.message || "Delete failed"));
});

// Add a phase to an existing session
router.post("/sessions/:sessionId/phases/add", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await addPhaseService(req.params.sessionId, req.body.name, cap);
  } catch (err) {
    return res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(err.message || "Failed to add phase"));
  }
  if (result.ok) return res.redirect("/sessions/" + req.params.sessionId + "/weeks?ok=1");
  return res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(result.message || "Failed to add phase"));
});

// Delete phase (and its weeks)
router.post("/sessions/:sessionId/phases/:phaseId/delete", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await deletePhaseService(req.params.sessionId, req.params.phaseId, cap);
  } catch (err) {
    return res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(err.message || "Delete failed"));
  }
  if (result.ok) return res.redirect("/sessions/" + req.params.sessionId + "/weeks?ok=1");
  return res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(result.message || "Delete failed"));
});

// Format a Date as YYYY-MM-DD for <input type="date"> value (browser-local).
function toDateInputValue(d) {
  if (!d) return "";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  const off = date.getTimezoneOffset();
  return new Date(date.getTime() - off * 60000).toISOString().slice(0, 10);
}

// ── Clone a week's tests into a new week ─────────────────────────────────
// Step 1: form to specify the new week details.
router.get("/sessions/:sessionId/weeks/:weekId/clone", requireAdminOrManager(), async (req, res) => {
  try {
    const ctx = await getCloneFormContextService(req.params.weekId);
    if (!ctx) return res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent("Week not found"));

    // Default the new week to start 7 days after the source week.
    const defaultStart = new Date(ctx.sourceWeek.startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    const defaultEnd = new Date(ctx.sourceWeek.endDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    const session = await TestSession.findById(req.params.sessionId).lean();
    if (!session) return res.redirect("/sessions/manage?error=" + encodeURIComponent("Session not found"));
    res.render("weeks/clone", {
      page: "sessions-manage",
      user: req.user,
      session,
      sourceWeek: ctx.sourceWeek,
      tests: ctx.tests,
      newName: ctx.sourceWeek.name + " (copy)",
      defaultStart,
      defaultEnd,
      cloneError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect("/sessions/" + req.params.sessionId + "/weeks?error=" + encodeURIComponent(err.message));
  }
});

// Step 2: preview (nothing written yet).
router.post("/sessions/:sessionId/weeks/:weekId/clone/preview", requireAdminOrManager(), async (req, res) => {
  const formUrl = "/sessions/" + req.params.sessionId + "/weeks/" + req.params.weekId + "/clone";
  try {
    const { name, startDate, endDate } = req.body;
    const preview = await buildCloneWeekPreviewService(req.params.weekId, { name, startDate, endDate });

    if (preview.error === "NO_TESTS") {
      return res.redirect(formUrl + "?error=" + encodeURIComponent("This week has no tests to clone."));
    }
    if (preview.error) {
      return res.redirect(formUrl + "?error=" + encodeURIComponent(preview.error));
    }

    const session = await TestSession.findById(req.params.sessionId).lean();
    if (!session) return res.redirect(formUrl + "?error=" + encodeURIComponent("Session not found"));
    const phaseDoc = session.phases.find((p) => String(p._id) === preview.sourceWeek.phase) || {};

    res.render("weeks/clone-preview", {
      page: "sessions-manage",
      user: req.user,
      session,
      phaseName: phaseDoc.name || "Unknown",
      preview,
      detailsJson: JSON.stringify({ name, startDate, endDate }),
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    return res.redirect(formUrl + "?error=" + encodeURIComponent(err.message || "Preview failed"));
  }
});

// Step 3: confirm and create.
router.post("/sessions/:sessionId/weeks/:weekId/clone/confirm", requireAdminOrManager(), async (req, res) => {
  const listUrl = "/sessions/" + req.params.sessionId + "/weeks";
  const formUrl = listUrl + "/" + req.params.weekId + "/clone";
  try {
    let details = req.body.details;
    if (typeof details === "string") {
      try { details = JSON.parse(details); } catch (_e) { details = {}; }
    }
    if (!details || !details.name || !details.startDate || !details.endDate) {
      return res.redirect(formUrl + "?error=" + encodeURIComponent("Missing new week details."));
    }

    const result = await executeCloneWeekService(req.params.weekId, details, req.user._id);
    return res.redirect(
      listUrl + "?ok=1&msg=" +
      encodeURIComponent(result.testsCreated + " test(s) cloned into new week \"" + result.week.name + "\"")
    );
  } catch (err) {
    return res.redirect(formUrl + "?error=" + encodeURIComponent(err.message || "Clone failed"));
  }
});

module.exports = router;
