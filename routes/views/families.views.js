const express = require("express");
const router = express.Router();
const { requireAdminOrManager } = require("../../middlewares/authView");
const Parent = require("../../models/Parents/parents.model");
const Student = require("../../models/Students/students.model");
const { paginate } = require("../../utils/paginate");

// GET /families — list all families
router.get("/families", requireAdminOrManager(), async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const search = (req.query.search || "").trim();

    // Build filter: search by parent name, family number, or student name
    const filter = { familyNumber: { $exists: true, $ne: null } };
    if (search) {
      const orClauses = [
        { name: { $regex: search, $options: "i" } },
        { familyNumber: { $regex: search, $options: "i" } },
      ];
      // Also search by child name — find matching parent IDs first
      const studentsMatch = await Student.find(
        { name: { $regex: search, $options: "i" }, familyNumber: { $exists: true, $ne: null } }
      ).select("familyNumber").lean();
      if (studentsMatch.length > 0) {
        const famNums = [...new Set(studentsMatch.map((s) => s.familyNumber))];
        orClauses.push({ familyNumber: { $in: famNums } });
      }
      filter.$or = orClauses;
    }

    const parentsResult = await paginate(Parent, filter, {
      page,
      limit,
      select: "-password",
      sort: "name",
      populate: {
        path: "children",
        select: "name rollNumber classLevel status",
        populate: { path: "classLevel", select: "name gradeLevel" },
      },
    });

    // Also find students with familyNumber but no linked parent (orphaned family links)
    const familyNumbers = parentsResult.data
      .filter((p) => p.familyNumber)
      .map((p) => p.familyNumber);
    const orphanedStudents = familyNumbers.length > 0
      ? await Student.find({
          familyNumber: { $in: familyNumbers },
          parent: null,
        })
          .select("name rollNumber familyNumber classLevel")
          .populate("classLevel", "name gradeLevel")
          .lean()
      : [];

    res.render("families/list", {
      page: "families",
      user: req.user,
      families: parentsResult.data || [],
      pagination: parentsResult.pagination || null,
      filters: { search },
      orphanedStudents,
      loadError: null,
      ok: req.query.ok === "1",
      successMsg: req.query.msg || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("families/list", {
      page: "families",
      user: req.user,
      families: [],
      pagination: null,
      filters: { search: "" },
      orphanedStudents: [],
      loadError: err.message,
      ok: false,
      successMsg: null,
      schoolName: res.locals.schoolName,
    });
  }
});

// GET /families/:familyId — detail/edit view for one family
router.get("/families/:familyId", requireAdminOrManager(), async (req, res) => {
  try {
    const parent = await Parent.findById(req.params.familyId)
      .select("-password")
      .populate({
        path: "children",
        select: "-password",
        populate: { path: "classLevel", select: "name gradeLevel group section" },
      });

    if (!parent) {
      return res.redirect("/families?error=" + encodeURIComponent("Family not found"));
    }

    // Find unlinked students (no familyNumber, no parent) for the add-student dropdown
    const unlinkedStudents = await Student.find({
      $or: [{ parent: null }, { familyNumber: null }],
      status: "active",
    })
      .select("name rollNumber classLevel")
      .populate("classLevel", "name gradeLevel")
      .sort("name")
      .lean();

    res.render("families/detail", {
      page: "families",
      user: req.user,
      family: parent,
      unlinkedStudents,
      ok: req.query.ok === "1",
      errorMsg: req.query.error || null,
      successMsg: req.query.msg || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    return res.redirect("/families?error=" + encodeURIComponent(err.message));
  }
});

// POST /families/:familyId/add-student — link a student to this family
router.post("/families/:familyId/add-student", requireAdminOrManager(), async (req, res) => {
  try {
    const { studentId } = req.body;
    if (!studentId) {
      return res.redirect(`/families/${req.params.familyId}?error=${encodeURIComponent("Please select a student.")}`);
    }

    const parent = await Parent.findById(req.params.familyId);
    if (!parent) {
      return res.redirect("/families?error=" + encodeURIComponent("Family not found"));
    }

    const student = await Student.findById(studentId);
    if (!student) {
      return res.redirect(`/families/${req.params.familyId}?error=${encodeURIComponent("Student not found.")}`);
    }

    // Check if already linked
    if (parent.children.some((c) => c.toString() === studentId)) {
      return res.redirect(`/families/${req.params.familyId}?error=${encodeURIComponent("Student is already in this family.")}`);
    }

    // If student was in another family, remove from old parent first
    if (student.parent && student.parent.toString() !== req.params.familyId) {
      await Parent.findByIdAndUpdate(student.parent, {
        $pull: { children: student._id },
      });
    }

    // Link student to this family
    await Parent.findByIdAndUpdate(req.params.familyId, {
      $push: { children: student._id },
    });
    await Student.findByIdAndUpdate(studentId, {
      $set: { familyNumber: parent.familyNumber, parent: parent._id },
    });

    return res.redirect(`/families/${req.params.familyId}?msg=${encodeURIComponent("Student added to family.")}`);
  } catch (err) {
    return res.redirect(`/families/${req.params.familyId}?error=${encodeURIComponent(err.message)}`);
  }
});

// POST /families/:familyId/remove-student — unlink a student from this family
router.post("/families/:familyId/remove-student", requireAdminOrManager(), async (req, res) => {
  try {
    const { studentId } = req.body;
    if (!studentId) {
      return res.redirect(`/families/${req.params.familyId}?error=${encodeURIComponent("Student ID is required.")}`);
    }

    const parent = await Parent.findById(req.params.familyId);
    if (!parent) {
      return res.redirect("/families?error=" + encodeURIComponent("Family not found"));
    }

    // Remove student from parent's children array
    await Parent.findByIdAndUpdate(req.params.familyId, {
      $pull: { children: studentId },
    });

    // Unlink the student: clear familyNumber and parent reference (don't delete the student)
    await Student.findByIdAndUpdate(studentId, {
      $set: { familyNumber: null, parent: null },
    });

    return res.redirect(`/families/${req.params.familyId}?msg=${encodeURIComponent("Student removed from family.")}`);
  } catch (err) {
    return res.redirect(`/families/${req.params.familyId}?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
