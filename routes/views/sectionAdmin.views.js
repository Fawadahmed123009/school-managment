const express = require("express");
const router = express.Router();
const { requireAdminOrManager } = require("../../middlewares/authView");
const {
  getAllSectionsService,
  getSectionService,
  createSectionService,
  updateSectionService,
  toggleSectionActiveService,
  deleteSectionService,
} = require("../../services/academic/section.service");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");

// ── List ────────────────────────────────────────────────────────
router.get("/sections", requireAdminOrManager(), async (req, res) => {
  try {
    const sections = await getAllSectionsService();
    res.render("sections/list", {
      page: "sections",
      user: req.user,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      sections: sections || [],
      loadError: null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("sections/list", {
      page: "sections",
      user: req.user,
      ok: false,
      createError: null,
      sections: [],
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

// ── Edit form ───────────────────────────────────────────────────
router.get("/sections/:sectionId/edit", requireAdminOrManager(), async (req, res) => {
  try {
    const section = await getSectionService(req.params.sectionId);
    if (!section) return res.redirect(`/sections?error=${encodeURIComponent("Section not found")}`);
    res.render("sections/edit", {
      page: "sections",
      user: req.user,
      section,
      saveError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect(`/sections?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Create ──────────────────────────────────────────────────────
router.post("/sections/create", requireAdminOrManager(), async (req, res) => {
  const { name } = req.body;
  const { res: cap, result } = captureServiceResponse();
  try {
    await createSectionService({ name }, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/sections?error=${encodeURIComponent(err.message || "Failed to create section")}`);
  }
  if (result.ok) return res.redirect("/sections?ok=1");
  return res.redirect(`/sections?error=${encodeURIComponent(result.message || "Failed to create section")}`);
});

// ── Update ──────────────────────────────────────────────────────
router.post("/sections/:sectionId/edit", requireAdminOrManager(), async (req, res) => {
  const { name } = req.body;
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateSectionService({ name }, req.params.sectionId, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/sections/${req.params.sectionId}/edit?error=${encodeURIComponent(err.message || "Update failed")}`);
  }
  if (result.ok) return res.redirect("/sections?ok=1");
  return res.redirect(`/sections/${req.params.sectionId}/edit?error=${encodeURIComponent(result.message || "Update failed")}`);
});

// ── Toggle active ───────────────────────────────────────────────
router.post("/sections/:sectionId/toggle-active", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await toggleSectionActiveService(req.params.sectionId, cap);
  } catch (err) {
    return res.redirect(`/sections?error=${encodeURIComponent(err.message || "Toggle failed")}`);
  }
  if (result.ok) return res.redirect("/sections?ok=1");
  return res.redirect(`/sections?error=${encodeURIComponent(result.message || "Toggle failed")}`);
});

// ── Delete ──────────────────────────────────────────────────────
router.post("/sections/:sectionId/delete", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await deleteSectionService(req.params.sectionId, cap);
  } catch (err) {
    return res.redirect(`/sections?error=${encodeURIComponent(err.message || "Delete failed")}`);
  }
  if (result.ok) return res.redirect("/sections?ok=1");
  return res.redirect(`/sections?error=${encodeURIComponent(err.message || "Delete failed")}`);
});

module.exports = router;
