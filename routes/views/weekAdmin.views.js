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
} = require("../../services/academic/week.service");
const { deletePhaseService } = require("../../services/academic/testSession.service");
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

module.exports = router;
