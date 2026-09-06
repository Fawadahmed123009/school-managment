const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const {
  getAllProgramsService,
  getProgramsService,
  createProgramService,
  updateProgramService,
  deleteProgramService,
} = require("../../services/academic/program.service");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");

// ── List ────────────────────────────────────────────────────────
router.get("/programs", requireRole("admin"), async (req, res) => {
  try {
    const programs = await getAllProgramsService();
    res.render("programs/list", {
      page: "programs",
      user: req.user,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      programs: programs || [],
      loadError: null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("programs/list", {
      page: "programs",
      user: req.user,
      ok: false,
      createError: null,
      programs: [],
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

// ── Edit form ───────────────────────────────────────────────────
router.get("/programs/:programId/edit", requireRole("admin"), async (req, res) => {
  try {
    const program = await getProgramsService(req.params.programId);
    if (!program) return res.redirect(`/programs?error=${encodeURIComponent("Program not found")}`);
    res.render("programs/edit", {
      page: "programs",
      user: req.user,
      program,
      saveError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect(`/programs?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Create ──────────────────────────────────────────────────────
router.post("/programs/create", requireRole("admin"), async (req, res) => {
  const { name, description } = req.body;
  const { res: cap, result } = captureServiceResponse();
  try {
    await createProgramService({ name, description }, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/programs?error=${encodeURIComponent(err.message || "Failed to create program")}`);
  }
  if (result.ok) return res.redirect("/programs?ok=1");
  return res.redirect(`/programs?error=${encodeURIComponent(result.message || "Failed to create program")}`);
});

// ── Update ──────────────────────────────────────────────────────
router.post("/programs/:programId/edit", requireRole("admin"), async (req, res) => {
  const { name, description } = req.body;
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateProgramService({ name, description }, req.params.programId, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/programs/${req.params.programId}/edit?error=${encodeURIComponent(err.message || "Update failed")}`);
  }
  if (result.ok) return res.redirect("/programs?ok=1");
  return res.redirect(`/programs/${req.params.programId}/edit?error=${encodeURIComponent(result.message || "Update failed")}`);
});

// ── Delete ──────────────────────────────────────────────────────
router.post("/programs/:programId/delete", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await deleteProgramService(req.params.programId, cap);
  } catch (err) {
    return res.redirect(`/programs?error=${encodeURIComponent(err.message || "Delete failed")}`);
  }
  if (result.ok) return res.redirect("/programs?ok=1");
  return res.redirect(`/programs?error=${encodeURIComponent(result.message || "Delete failed")}`);
});

module.exports = router;
