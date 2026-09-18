const express = require("express");
const router = express.Router();
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");
const {
  getAllClassesService,
  getClassLevelsService,
  createClassLevelService,
  updateClassLevelService,
  deleteClassLevelService,
} = require("../../services/academic/class.service");
const { getAllSectionsService } = require("../../services/academic/section.service");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");

router.get("/classes", requireAdminOrManager(), async (req, res) => {
  try {
    const [classes, sections] = await Promise.all([
      getAllClassesService(),
      getAllSectionsService(),
    ]);
    res.render("classes/list", {
      page: "classes",
      user: req.user,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      classes: classes || [],
      sections: sections || [],
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
      sections: [],
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

router.get("/classes/:classLevelId/edit", requireAdminOrManager(), async (req, res) => {
  try {
    const [cls, sections] = await Promise.all([
      getClassLevelsService(req.params.classLevelId),
      getAllSectionsService(),
    ]);
    if (!cls) return res.redirect(`/classes?error=${encodeURIComponent("Class not found")}`);
    res.render("classes/edit", {
      page: "classes",
      user: req.user,
      cls,
      sections: sections || [],
      saveError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect(`/classes?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/classes/create", requireAdminOrManager(), async (req, res) => {
  const { name, gradeLevel, group, section, sectionRef, description } = req.body;
  const { res: cap, result } = captureServiceResponse();
  try {
    await createClassLevelService({ name, gradeLevel, group: group || null, section: section || null, sectionRef: sectionRef || null, description }, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/classes?error=${encodeURIComponent(err.message || "Failed to create class")}`);
  }
  if (result.ok) return res.redirect("/classes?ok=1");
  return res.redirect(`/classes?error=${encodeURIComponent(result.message || "Failed to create class")}`);
});

router.post("/classes/:classLevelId/edit", requireAdminOrManager(), async (req, res) => {
  const { name, gradeLevel, group, section, sectionRef, description } = req.body;
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateClassLevelService({ name, gradeLevel, group: group || null, section: section || null, sectionRef: sectionRef || null, description }, req.params.classLevelId, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/classes/${req.params.classLevelId}/edit?error=${encodeURIComponent(err.message || "Update failed")}`);
  }
  if (result.ok) return res.redirect("/classes?ok=1");
  return res.redirect(`/classes/${req.params.classLevelId}/edit?error=${encodeURIComponent(result.message || "Update failed")}`);
});

router.post("/classes/:classLevelId/delete", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await deleteClassLevelService(req.params.classLevelId, cap);
  } catch (err) {
    return res.redirect(`/classes?error=${encodeURIComponent(err.message || "Delete failed")}`);
  }
  if (result.ok) return res.redirect("/classes?ok=1");
  return res.redirect(`/classes?error=${encodeURIComponent(result.message || "Delete failed")}`);
});

module.exports = router;
