const express = require("express");
const router = express.Router();
const Assignment = require("../../models/Academic/assignment.model");
const Student = require("../../models/Students/students.model");
const { requireRole } = require("../../middlewares/authView");
const logger = require("../../config/logger");

// ── Teacher: "My Classes" page ──
// The class list that used to sit on the dashboard, now on its own page linked
// from the sidebar. Scoped to the teacher's own assignments (the ONE scoping
// source used across the teacher dashboard), grouped by subject, each class
// showing its grade + live enrolled-student count.
router.get("/teacher/my-classes", requireRole("teacher"), async (req, res) => {
  const teacherId = req.user._id;
  // Active-enrolled triple (project-wide convention).
  const ACTIVE = { status: { $ne: "inactive" }, isGraduated: { $ne: true }, isWithdrawn: { $ne: true } };

  let groups = [];
  let totalClasses = 0;
  try {
    const assignments = await Assignment.find({ teacher: teacherId })
      .populate("subject", "name")
      .populate("classLevel", "name gradeLevel group section")
      .lean();

    // Distinct classes (a class taught for two subjects is ONE class) + enrolled
    // counts, fetched in a single aggregate. `.lean()` returns the populated
    // classLevel._id as a real ObjectId, so the $in cast is safe here.
    const classesById = new Map();
    assignments.forEach((a) => {
      if (a.classLevel && a.classLevel._id) classesById.set(String(a.classLevel._id), a.classLevel);
    });
    const classObjIds = [...classesById.values()].map((c) => c._id);
    const counts = classObjIds.length
      ? await Student.aggregate([
          { $match: { ...ACTIVE, classLevel: { $in: classObjIds } } },
          { $group: { _id: "$classLevel", n: { $sum: 1 } } },
        ])
      : [];
    const countById = {};
    counts.forEach((c) => { countById[String(c._id)] = c.n; });

    // Group by subject name, each subject carrying its distinct classes.
    const bySubject = new Map();
    assignments.forEach((a) => {
      const subjectName = (a.subject && a.subject.name) || "Unassigned";
      if (!bySubject.has(subjectName)) bySubject.set(subjectName, new Map());
      const classMap = bySubject.get(subjectName);
      if (a.classLevel && a.classLevel._id && !classMap.has(String(a.classLevel._id))) {
        const c = a.classLevel;
        classMap.set(String(c._id), {
          id: String(c._id),
          name: c.name || "Class",
          gradeLevel: c.gradeLevel || "",
          group: c.group || null,
          section: c.section || null,
          students: countById[String(c._id)] || 0,
        });
      }
    });

    groups = [...bySubject.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([subject, classMap]) => ({ subject, classes: [...classMap.values()] }));
    totalClasses = classesById.size;
  } catch (err) {
    logger.warn("Teacher my-classes error | " + (err && err.message ? err.message : String(err)));
  }

  res.render("teacher/myClasses", {
    page: "teacher-my-classes",
    user: req.user,
    groups,
    totalClasses,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
