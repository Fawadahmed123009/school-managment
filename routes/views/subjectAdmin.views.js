const express = require("express");
const router = express.Router();
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");
const {
  getAllSubjectsService,
  getSubjectsService,
  createSubjectService,
  updateSubjectService,
  deleteSubjectService,
} = require("../../services/academic/subject.service");
const { getAllProgramsService } = require("../../services/academic/program.service");
const ClassLevel = require("../../models/Academic/class.model");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");

// ── Helpers ─────────────────────────────────────────────────────
// Build a reverse map: subjectId → program name, so the list view
// can show which program each subject belongs to.
async function buildSubjectProgramMap() {
  const programs = await getAllProgramsService();
  const map = new Map();
  (programs || []).forEach((p) => {
    (p.subjects || []).forEach((sId) => {
      map.set(String(sId), { programId: String(p._id), programName: p.name });
    });
  });
  return map;
}

// Parse appliesTo fields from the form body.
// The form uses indexed field names: classLevel_<N>, required_<N>, etc.
// When wholeGrade_<N> is checked, the row uses gradeLevel_<N> instead of classLevel_<N>.
function parseAppliesTo(body) {
  const count = parseInt(body.appliesToCount, 10) || 0;
  const appliesTo = [];
  for (let i = 0; i < count; i++) {
    const isWholeGrade = body[`wholeGrade_${i}`] === "on" || body[`wholeGrade_${i}`] === "true";
    const required = body[`required_${i}`] === "on" || body[`required_${i}`] === "true";
    if (isWholeGrade) {
      const gradeLevel = body[`gradeLevel_${i}`];
      if (!gradeLevel) continue;
      appliesTo.push({ gradeLevel, required });
    } else {
      const classLevel = body[`classLevel_${i}`];
      if (!classLevel) continue;
      appliesTo.push({ classLevel, required });
    }
  }
  return appliesTo;
}

// ── List ────────────────────────────────────────────────────────
router.get("/subjects", requireAdminOrManager(), async (req, res) => {
  try {
    const [subjects, programs, classLevels, subjectProgramMap] = await Promise.all([
      getAllSubjectsService(),
      getAllProgramsService(),
      ClassLevel.find({}).sort({ gradeLevel: 1, name: 1 }),
      buildSubjectProgramMap(),
    ]);
    res.render("subjects/list", {
      page: "subjects",
      user: req.user,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      subjects: subjects || [],
      programs: programs || [],
      classLevels: classLevels || [],
      subjectProgramMap,
      loadError: null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("subjects/list", {
      page: "subjects",
      user: req.user,
      ok: false,
      createError: null,
      subjects: [],
      programs: [],
      classLevels: [],
      subjectProgramMap: new Map(),
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

// ── Edit form ───────────────────────────────────────────────────
router.get("/subjects/:subjectId/edit", requireAdminOrManager(), async (req, res) => {
  try {
    const [subject, programs, classLevels, subjectProgramMap] = await Promise.all([
      getSubjectsService(req.params.subjectId),
      getAllProgramsService(),
      ClassLevel.find({}).sort({ gradeLevel: 1, name: 1 }),
      buildSubjectProgramMap(),
    ]);
    if (!subject) return res.redirect(`/subjects?error=${encodeURIComponent("Subject not found")}`);
    const programInfo = subjectProgramMap.get(String(subject._id)) || {};
    res.render("subjects/edit", {
      page: "subjects",
      user: req.user,
      subject,
      programs: programs || [],
      classLevels: classLevels || [],
      currentProgramId: programInfo.programId || "",
      saveError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect(`/subjects?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Create ──────────────────────────────────────────────────────
router.post("/subjects/create", requireAdminOrManager(), async (req, res) => {
  const { name, description, programId } = req.body;
  const appliesTo = parseAppliesTo(req.body);
  const { res: cap, result } = captureServiceResponse();
  try {
    await createSubjectService({ name, description, appliesTo }, programId, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/subjects?error=${encodeURIComponent(err.message || "Failed to create subject")}`);
  }
  if (result.ok) return res.redirect("/subjects?ok=1");
  return res.redirect(`/subjects?error=${encodeURIComponent(result.message || "Failed to create subject")}`);
});

// ── Update ──────────────────────────────────────────────────────
router.post("/subjects/:subjectId/edit", requireAdminOrManager(), async (req, res) => {
  const { name, description } = req.body;
  const appliesTo = parseAppliesTo(req.body);
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateSubjectService({ name, description, appliesTo }, req.params.subjectId, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/subjects/${req.params.subjectId}/edit?error=${encodeURIComponent(err.message || "Update failed")}`);
  }
  if (result.ok) return res.redirect("/subjects?ok=1");
  return res.redirect(`/subjects/${req.params.subjectId}/edit?error=${encodeURIComponent(result.message || "Update failed")}`);
});

// ── Delete ──────────────────────────────────────────────────────
router.post("/subjects/:subjectId/delete", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await deleteSubjectService(req.params.subjectId, cap);
  } catch (err) {
    return res.redirect(`/subjects?error=${encodeURIComponent(err.message || "Delete failed")}`);
  }
  if (result.ok) return res.redirect("/subjects?ok=1");
  return res.redirect(`/subjects?error=${encodeURIComponent(result.message || "Delete failed")}`);
});

module.exports = router;
