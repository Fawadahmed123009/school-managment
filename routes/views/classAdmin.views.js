const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const {
  getAllClassesService,
  getClassLevelsService,
  createClassLevelService,
  updateClassLevelService,
  deleteClassLevelService,
} = require("../../services/academic/class.service");

router.get("/classes", requireRole("admin"), async (req, res) => {
  try {
    const classes = await getAllClassesService();
    res.render("classes/list", {
      page: "classes",
      user: req.user,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      classes: classes || [],
      loadError: null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("classes/list", {
      page: "classes",
      user: req.user,
      ok: false,
      createError: null,
      classes: [],
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

router.get("/classes/:classLevelId/edit", requireRole("admin"), async (req, res) => {
  try {
    const cls = await getClassLevelsService(req.params.classLevelId);
    if (!cls) return res.redirect(`/classes?error=${encodeURIComponent("Class not found")}`);
    res.render("classes/edit", {
      page: "classes",
      user: req.user,
      cls,
      saveError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect(`/classes?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/classes/create", requireRole("admin"), async (req, res) => {
  const { name, gradeLevel, group, section, description } = req.body;
  try {
    await createClassLevelService({ name, gradeLevel, group: group || null, section: section || null, description }, req.user._id, res);
    if (!res.headersSent) return res.redirect("/classes?ok=1");
  } catch (err) {
    // ignore
  }
  if (!res.headersSent) return res.redirect(`/classes?error=${encodeURIComponent("Failed to create class")}`);
});

router.post("/classes/:classLevelId/edit", requireRole("admin"), async (req, res) => {
  const { name, gradeLevel, group, section, description } = req.body;
  try {
    await updateClassLevelService({ name, gradeLevel, group: group || null, section: section || null, description }, req.params.classLevelId, req.user._id, res);
    if (!res.headersSent) return res.redirect("/classes?ok=1");
  } catch (err) {
    // ignore
  }
  if (!res.headersSent) return res.redirect(`/classes/${req.params.classLevelId}/edit?error=${encodeURIComponent("Update failed")}`);
});

router.post("/classes/:classLevelId/delete", requireRole("admin"), async (req, res) => {
  try {
    await deleteClassLevelService(req.params.classLevelId, res);
  } catch (err) {
    // ignore
  }
  if (!res.headersSent) res.redirect("/classes?ok=1");
});

module.exports = router;
