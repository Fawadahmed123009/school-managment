const express = require("express");
const router = express.Router();
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");
const {
  adminRegisterStudentService,
  getStudentByAdminService,
  adminUpdateStudentService,
  adminDeleteStudentService,
  updateLinkedParentService,
  addParentToStudentService,
} = require("../../services/students/students.service");
const { getAllClassesService } = require("../../services/academic/class.service");
const { adminResetParentPasswordService } = require("../../services/parents/parents.service");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const Parent = require("../../models/Parents/parents.model");
const Student = require("../../models/Students/students.model");

router.get("/students", requireAdminOrManager(), async (req, res) => {
  try {
    const page = req.query.page || 1;
    const limit = req.query.limit || 20;
    const classFilter = req.query.class || "";
    const nameSearch = (req.query.name || "").trim();
    const parentSearch = (req.query.parent || "").trim();
    const sortBy = req.query.sortBy || "";

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
        // Build sort and optional collation for numeric roll-number ordering
        var sortOpt = "name";
        var collationOpt = undefined;
        if (sortBy === "rollAsc")  { sortOpt = { rollNumber: 1 };  collationOpt = { locale: "en", numericOrdering: true }; }
        if (sortBy === "rollDesc") { sortOpt = { rollNumber: -1 }; collationOpt = { locale: "en", numericOrdering: true }; }
        return paginate(Student, filter, {
          page,
          limit,
          select: "-password",
          sort: sortOpt,
          collation: collationOpt,
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
      filters: { class: classFilter, name: nameSearch, parent: parentSearch, sortBy: sortBy },
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
      filters: { class: "", name: "", parent: "", sortBy: "" },
      totalStudents: 0,
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

router.post("/students/create", requireAdminOrManager(), async (req, res) => {
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

  // --- Family-match confirmation: service returned status "confirm" ---
  if (result.body && result.body.status === "confirm") {
    return res.render("students/family-confirm", {
      page: "students",
      user: req.user,
      matchedParent: result.body.data.matchedParent,
      formData: data,
      schoolName: res.locals.schoolName,
    });
  }

  // --- Success: check if a new parent account was auto-created ---
  if (result.ok) {
    const creds = result.body.data && result.body.data.newParentCredentials;
    if (creds) {
      return res.render("students/parent-created", {
        page: "students",
        user: req.user,
        credentials: creds,
        studentName: data.name,
        schoolName: res.locals.schoolName,
      });
    }
    return res.redirect("/students?ok=1");
  }

  return res.redirect(`/students?error=${encodeURIComponent(result.message || "Failed to create student.")}`);
});

// GET /students/:studentId/edit — edit form
router.get("/students/:studentId/edit", requireAdminOrManager(), async (req, res) => {
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
      successMsg: req.query.parentUpdated === "1" ? "Parent details updated successfully." : req.query.parentAdded === "1" ? "Parent details added and linked successfully." : null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.redirect("/students?error=" + encodeURIComponent(err.message));
  }
});

// POST /students/:studentId/update — save edits
router.post("/students/:studentId/update", requireAdminOrManager(), async (req, res) => {
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
router.post("/students/:studentId/delete", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await adminDeleteStudentService(req.params.studentId, cap);
  } catch (err) {
    return res.redirect(`/students?error=${encodeURIComponent(err.message || "Delete failed")}`);
  }
  if (result.ok) return res.redirect("/students?ok=1");
  return res.redirect(`/students?error=${encodeURIComponent(result.message || "Delete failed")}`);
});

// POST /students/:studentId/reset-parent-password — admin/manager reset parent password
router.post("/students/:studentId/reset-parent-password", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await adminResetParentPasswordService(req.params.studentId, req.body, cap);
  } catch (err) {
    return res.redirect(`/students/${req.params.studentId}/edit?error=${encodeURIComponent(err.message || "Password reset failed")}`);
  }

  if (result.ok) {
    const data = result.body.data;
    return res.redirect(`/students/${req.params.studentId}/parent-password-reset?password=${encodeURIComponent(data.password)}&parentName=${encodeURIComponent(data.parentName)}&parentEmail=${encodeURIComponent(data.parentEmail)}`);
  }
  return res.redirect(`/students/${req.params.studentId}/edit?error=${encodeURIComponent(result.message || "Password reset failed")}`);
});

// GET /students/:studentId/parent-password-reset — show reset confirmation
router.get("/students/:studentId/parent-password-reset", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await getStudentByAdminService(req.params.studentId, cap);
  } catch (err) {
    return res.redirect("/students?error=" + encodeURIComponent(err.message));
  }

  const student = result.ok ? result.body.data : null;
  if (!student) {
    return res.redirect("/students?error=Student not found");
  }

  res.render("students/parent-reset-confirm", {
    page: "students",
    user: req.user,
    student,
    credentials: {
      name: req.query.parentName,
      email: req.query.parentEmail,
      password: req.query.password,
    },
    schoolName: res.locals.schoolName,
  });
});

// POST /students/:studentId/update-parent — update linked parent's basic info (Feature 1)
router.post("/students/:studentId/update-parent", requireAdminOrManager(), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateLinkedParentService(req.params.studentId, req.body, cap);
  } catch (err) {
    return res.redirect(`/students/${req.params.studentId}/edit?error=${encodeURIComponent(err.message || "Update failed")}`);
  }
  if (result.ok) return res.redirect(`/students/${req.params.studentId}/edit?parentUpdated=1`);
  return res.redirect(`/students/${req.params.studentId}/edit?error=${encodeURIComponent(result.message || "Update failed")}`);
});

// POST /students/:studentId/add-parent — add parent to unlinked student (Feature 2)
router.post("/students/:studentId/add-parent", requireAdminOrManager(), async (req, res) => {
  const fields = ["parentName", "parentEmail", "parentPhone", "relationship", "familyAction"];
  const data = {};
  fields.forEach((f) => { if (req.body[f] !== undefined) data[f] = req.body[f]; });

  const { res: cap, result } = captureServiceResponse();
  try {
    await addParentToStudentService(req.params.studentId, data, cap);
  } catch (err) {
    return res.redirect(`/students/${req.params.studentId}/edit?error=${encodeURIComponent(err.message || "Failed to add parent")}`);
  }

  // Family-match confirmation needed
  if (result.body && result.body.status === "confirm") {
    return res.render("students/family-confirm-addparent", {
      page: "students",
      user: req.user,
      matchedParent: result.body.data.matchedParent,
      formData: data,
      studentId: req.params.studentId,
      schoolName: res.locals.schoolName,
    });
  }

  // Success: check if a new parent account was auto-created
  if (result.ok) {
    const creds = result.body.data && result.body.data.newParentCredentials;
    if (creds) {
      return res.render("students/parent-created", {
        page: "students",
        user: req.user,
        credentials: creds,
        studentName: (await Student.findById(req.params.studentId)).name,
        schoolName: res.locals.schoolName,
      });
    }
    return res.redirect(`/students/${req.params.studentId}/edit?parentAdded=1`);
  }

  return res.redirect(`/students/${req.params.studentId}/edit?error=${encodeURIComponent(result.message || "Failed to add parent")}`);
});

module.exports = router;
