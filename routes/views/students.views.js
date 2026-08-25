const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const {
  adminRegisterStudentService,
  getStudentByAdminService,
  adminUpdateStudentService,
  adminDeleteStudentService,
} = require("../../services/students/students.service");
const { getAllClassesService } = require("../../services/academic/class.service");

router.get("/students", requireRole("admin"), async (req, res) => {
  try {
    const [studentsResult, classes] = await Promise.all([
      (async () => {
        // Use paginate directly
        const Student = require("../../models/Students/students.model");
        const { paginate } = require("../../utils/paginate");
        return paginate(Student, {}, {
          page: req.query.page,
          limit: req.query.limit,
          select: "-password",
          sort: "name",
          populate: { path: "classLevel", select: "name gradeLevel group section" },
        });
      })(),
      getAllClassesService(),
    ]);
    res.render("students/list", {
      page: "students",
      user: req.user,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      students: studentsResult.data || [],
      pagination: studentsResult.pagination || null,
      classes: classes || [],
      loadError: null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("students/list", {
      page: "students",
      user: req.user,
      ok: false,
      createError: null,
      students: [],
      classes: [],
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

router.post("/students/create", requireRole("admin"), async (req, res) => {
  const fields = [
    "name", "email", "password", "classLevel", "rollNumber", "fatherName",
    "address", "whatsappNumber", "feeAgreed", "gender", "parentName",
    "parentEmail", "parentPhone", "relationship", "familyAction",
  ];
  const data = {};
  fields.forEach((f) => { if (req.body[f] !== undefined) data[f] = req.body[f]; });

  try {
    await adminRegisterStudentService(data, req.user._id, res);
    // Service may have sent a response (family match confirm) or may not have
    if (!res.headersSent) {
      // Check if the service returned "confirm" status (family match)
      // The service sends JSON response, but since we're in a view route,
      // we need to handle the redirect ourselves
      return res.redirect("/students?ok=1");
    }
  } catch (err) {
    if (!res.headersSent) {
      return res.redirect(`/students?error=${encodeURIComponent(err.message)}`);
    }
  }
});

// GET /students/:studentId/edit — edit form
router.get("/students/:studentId/edit", requireRole("admin"), async (req, res) => {
  try {
    const [student, classes] = await Promise.all([
      getStudentByAdminService(req.params.studentId),
      getAllClassesService(),
    ]);
    if (!student) {
      return res.redirect("/students?error=" + encodeURIComponent("Student not found"));
    }
    res.render("students/edit", {
      page: "students",
      user: req.user,
      student,
      classes: classes || [],
      editError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect("/students?error=" + encodeURIComponent(err.message));
  }
});

// POST /students/:studentId/update — save edits
router.post("/students/:studentId/update", requireRole("admin"), async (req, res) => {
  try {
    await adminUpdateStudentService(req.body, req.params.studentId, res);
    if (!res.headersSent) return res.redirect("/students?ok=1");
  } catch (err) {
    // ignore
  }
  if (!res.headersSent) {
    return res.redirect(`/students/${req.params.studentId}/edit?error=${encodeURIComponent("Update failed")}`);
  }
});

// POST /students/:studentId/delete — delete student
router.post("/students/:studentId/delete", requireRole("admin"), async (req, res) => {
  try {
    await adminDeleteStudentService(req.params.studentId, res);
    if (!res.headersSent) return res.redirect("/students?ok=1");
  } catch (err) {
    // ignore
  }
  if (!res.headersSent) {
    return res.redirect(`/students?error=${encodeURIComponent("Delete failed")}`);
  }
});

module.exports = router;
