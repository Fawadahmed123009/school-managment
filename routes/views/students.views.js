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
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const Parent = require("../../models/Parents/parents.model");

router.get("/students", requireRole("admin"), async (req, res) => {
  try {
    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const classFilter = req.query.class || "";
    const nameSearch = (req.query.name || "").trim();
    const parentSearch = (req.query.parent || "").trim();

    // Build MongoDB query filter
    const filter = {};
    if (classFilter) filter.classLevel = classFilter;
    if (nameSearch) filter.name = { $regex: nameSearch, $options: "i" };

    // Parent-name search: $or across Student.fatherName and linked Parent.name
    // (identical logic to the /fees filter)
    if (parentSearch) {
      const parentClause = [];
      // Branch 1: fatherName directly on Student
      parentClause.push({ fatherName: { $regex: parentSearch, $options: "i" } });
      // Branch 2: linked Parent document's name
      const matchingParents = await Parent.find(
        { name: { $regex: parentSearch, $options: "i" } }
      ).select("_id");
      if (matchingParents.length > 0) {
        parentClause.push({ parent: { $in: matchingParents.map((p) => p._id) } });
      }
      const orClause = parentClause.length === 1 ? parentClause[0] : { $or: parentClause };

      // Combine with any existing filter via $and
      if (Object.keys(filter).length > 0) {
        const combined = { $and: [filter, orClause] };
        Object.assign(filter, combined);
      } else {
        Object.assign(filter, orClause);
      }
    }

    const [studentsResult, classes] = await Promise.all([
      (async () => {
        const Student = require("../../models/Students/students.model");
        const { paginate } = require("../../utils/paginate");
        return paginate(Student, filter, {
          page,
          limit,
          select: "-password",
          sort: "name",
          populate: { path: "classLevel", select: "name gradeLevel group section" },
        });
      })(),
      getAllClassesService(),
    ]);

    const totalStudents = await require("../../models/Students/students.model").countDocuments();

    res.render("students/list", {
      page: "students",
      user: req.user,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      students: studentsResult.data || [],
      pagination: studentsResult.pagination || null,
      classes: classes || [],
      filters: { class: classFilter, name: nameSearch, parent: parentSearch },
      totalStudents,
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
      filters: { class: "", name: "", parent: "" },
      totalStudents: 0,
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

  const { res: cap, result } = captureServiceResponse();
  try {
    await adminRegisterStudentService(data, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/students?error=${encodeURIComponent(err.message || "Failed to create student.")}`);
  }
  if (result.ok) return res.redirect("/students?ok=1");
  return res.redirect(`/students?error=${encodeURIComponent(result.message || "Failed to create student.")}`);
});

// GET /students/:studentId/edit — edit form
router.get("/students/:studentId/edit", requireRole("admin"), async (req, res) => {
  try {
    const { res: cap, result } = captureServiceResponse();
    const [, classes] = await Promise.all([
      getStudentByAdminService(req.params.studentId, cap),
      getAllClassesService(),
    ]);
    const student = result.ok ? result.body.data : null;
    if (!student) {
      return res.redirect("/students?error=" + encodeURIComponent(result.message || "Student not found"));
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
  const { res: cap, result } = captureServiceResponse();
  try {
    await adminUpdateStudentService(req.body, req.params.studentId, cap);
  } catch (err) {
    return res.redirect(`/students/${req.params.studentId}/edit?error=${encodeURIComponent(err.message || "Update failed")}`);
  }
  if (result.ok) return res.redirect("/students?ok=1");
  return res.redirect(`/students/${req.params.studentId}/edit?error=${encodeURIComponent(result.message || "Update failed")}`);
});

// POST /students/:studentId/delete — delete student
router.post("/students/:studentId/delete", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await adminDeleteStudentService(req.params.studentId, cap);
  } catch (err) {
    return res.redirect(`/students?error=${encodeURIComponent(err.message || "Delete failed")}`);
  }
  if (result.ok) return res.redirect("/students?ok=1");
  return res.redirect(`/students?error=${encodeURIComponent(result.message || "Delete failed")}`);
});

module.exports = router;
