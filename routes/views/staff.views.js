const express = require("express");
const router = express.Router();
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");
const {
  getAllTeachersService,
  createTeacherService,
  adminGetTeacherService,
  adminUpdateCredentialsService,
  deleteTeacherService,
  toggleAttendanceManagerService,
} = require("../../services/staff/teachers.service");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");

// ── List all teachers ──
router.get("/staff", requireAdminOrManager(), async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const result = await getAllTeachersService(req.query);
    res.render("staff/list", {
      page: "staff",
      user: req.user,
      ok: req.query.ok === "1",
      error: req.query.error || null,
      teachers: result.data || [],
      pagination: result.pagination || null,
      filters: { search },
      loadError: null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("staff/list", {
      page: "staff",
      user: req.user,
      ok: false,
      error: null,
      teachers: [],
      pagination: null,
      filters: { search: "" },
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

// ── New teacher form ──
router.get("/staff/new", requireAdminOrManager(), async (req, res) => {
  res.render("staff/new", {
    page: "staff",
    user: req.user,
    error: null,
    schoolName: res.locals.schoolName,
  });
});

// ── Create teacher ──
router.post("/staff/create", requireAdminOrManager(), async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render("staff/new", {
      page: "staff",
      user: req.user,
      error: "Name, email and password are required.",
      schoolName: res.locals.schoolName,
    });
  }
  const { res: cap, result } = captureServiceResponse();
  try {
    await createTeacherService({ name, email, password }, req.user._id, cap);
  } catch (err) {
    return res.render("staff/new", {
      page: "staff",
      user: req.user,
      error: err.message || "Failed to create teacher.",
      schoolName: res.locals.schoolName,
    });
  }
  if (result.ok) return res.redirect("/staff?ok=1");
  return res.render("staff/new", {
    page: "staff",
    user: req.user,
    error: result.message || "Failed to create teacher.",
    schoolName: res.locals.schoolName,
  });
});

// ── Edit teacher form ──
router.get("/staff/:teacherId/edit", requireAdminOrManager(), async (req, res) => {
  try {
    const teacher = await adminGetTeacherService(req.params.teacherId);
    if (!teacher) return res.redirect("/staff?error=Teacher+not+found");
    res.render("staff/edit", {
      page: "staff",
      user: req.user,
      teacher,
      error: null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect("/staff?error=" + encodeURIComponent(err.message));
  }
});

// ── Update teacher credentials ──
router.post("/staff/:teacherId/edit", requireAdminOrManager(), async (req, res) => {
  const { name, email, password } = req.body;
  const body = {};
  if (name) body.name = name;
  if (email) body.email = email;
  if (password) body.password = password;

  const { res: cap, result } = captureServiceResponse();
  try {
    await adminUpdateCredentialsService(body, req.params.teacherId, cap);
  } catch (err) {
    // fall through to the error re-render below
  }

  if (result.ok) return res.redirect("/staff?ok=1");

  const teacher = await adminGetTeacherService(req.params.teacherId).catch(() => null);
  res.render("staff/edit", {
    page: "staff",
    user: req.user,
    teacher: teacher || { _id: req.params.teacherId, name, email },
    error: result.message || "Failed to update teacher.",
    schoolName: res.locals.schoolName,
  });
});

// ── Delete teacher ──
router.post("/staff/:teacherId/delete", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await deleteTeacherService(req.params.teacherId, cap);
  } catch (err) {
    return res.redirect("/staff?error=" + encodeURIComponent(err.message || "Failed to delete teacher."));
  }
  if (result.ok) return res.redirect("/staff?ok=1");
  return res.redirect("/staff?error=" + encodeURIComponent(result.message || "Failed to delete teacher."));
});

// ── Toggle attendance manager ──
router.post("/staff/:teacherId/toggle-attendance-manager", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await toggleAttendanceManagerService(req.params.teacherId, cap);
  } catch (err) {
    return res.redirect("/staff?error=" + encodeURIComponent(err.message || "Failed to update attendance manager."));
  }
  if (result.ok) return res.redirect("/staff?ok=1");
  return res.redirect("/staff?error=" + encodeURIComponent(result.message || "Failed to update attendance manager."));
});

module.exports = router;
