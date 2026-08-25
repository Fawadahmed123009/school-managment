const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const {
  getAllTeachersService,
  createTeacherService,
  adminGetTeacherService,
  adminUpdateCredentialsService,
  deleteTeacherService,
  toggleAttendanceManagerService,
} = require("../../services/staff/teachers.service");

// ── List all teachers ──
router.get("/staff", requireRole("admin"), async (req, res) => {
  try {
    const result = await getAllTeachersService(req.query);
    res.render("staff/list", {
      page: "staff",
      user: req.user,
      ok: req.query.ok === "1",
      error: req.query.error || null,
      teachers: result.data || [],
      pagination: result.pagination || null,
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
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

// ── New teacher form ──
router.get("/staff/new", requireRole("admin"), async (req, res) => {
  res.render("staff/new", {
    page: "staff",
    user: req.user,
    error: null,
    schoolName: res.locals.schoolName,
  });
});

// ── Create teacher ──
router.post("/staff/create", requireRole("admin"), async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render("staff/new", {
      page: "staff",
      user: req.user,
      error: "Name, email and password are required.",
      schoolName: res.locals.schoolName,
    });
  }
  try {
    await createTeacherService({ name, email, password }, req.user._id, res);
    // If response hasn't been sent (service sends its own response), redirect
    if (!res.headersSent) return res.redirect("/staff?ok=1");
  } catch (err) {
    if (!res.headersSent) {
      return res.render("staff/new", {
        page: "staff",
        user: req.user,
        error: err.message || "Failed to create teacher.",
        schoolName: res.locals.schoolName,
      });
    }
  }
});

// ── Edit teacher form ──
router.get("/staff/:teacherId/edit", requireRole("admin"), async (req, res) => {
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
router.post("/staff/:teacherId/edit", requireRole("admin"), async (req, res) => {
  const { name, email, password } = req.body;
  const body = {};
  if (name) body.name = name;
  if (email) body.email = email;
  if (password) body.password = password;

  try {
    await adminUpdateCredentialsService(body, req.params.teacherId, res);
    if (!res.headersSent) return res.redirect("/staff?ok=1");
  } catch (err) {
    // fall through
  }

  if (!res.headersSent) {
    const teacher = await adminGetTeacherService(req.params.teacherId).catch(() => null);
    res.render("staff/edit", {
      page: "staff",
      user: req.user,
      teacher: teacher || { _id: req.params.teacherId, name, email },
      error: "Failed to update teacher.",
      schoolName: res.locals.schoolName,
    });
  }
});

// ── Delete teacher ──
router.post("/staff/:teacherId/delete", requireRole("admin"), async (req, res) => {
  try {
    await deleteTeacherService(req.params.teacherId, res);
    if (!res.headersSent) return res.redirect("/staff?ok=1");
  } catch (err) {
    // ignore
  }
  if (!res.headersSent) res.redirect("/staff?error=" + encodeURIComponent("Failed to delete teacher."));
});

// ── Toggle attendance manager ──
router.post("/staff/:teacherId/toggle-attendance-manager", requireRole("admin"), async (req, res) => {
  try {
    await toggleAttendanceManagerService(req.params.teacherId, res);
  } catch (err) {
    // ignore
  }
  if (!res.headersSent) res.redirect("/staff?ok=1");
});

module.exports = router;
