const express = require("express");
const router = express.Router();
const { requireAdminOrManager } = require("../../middlewares/authView");
const { getAllClassesService } = require("../../services/academic/class.service");
const {
  buildPromotionPreview,
  executePromotion,
} = require("../../services/students/promotion.service");
const Student = require("../../models/Students/students.model");
const ClassLevel = require("../../models/Academic/class.model");

// ── Step 1: pick source class, assign per-student targets ─────────
router.get("/students/promote", requireAdminOrManager(), async (req, res) => {
  try {
    const [classes, sourceData] = await Promise.all([
      getAllClassesService(),
      req.query.sourceClass
        ? buildPromotionPreview(req.query.sourceClass)
        : Promise.resolve(null),
    ]);

    res.render("promotion/index", {
      page: "students-promote",
      user: req.user,
      classes: classes || [],
      sourceClass: req.query.sourceClass || "",
      students: sourceData ? sourceData.students : [],
      allClasses: sourceData ? sourceData.allClasses : classes || [],
      ok: req.query.ok === "1",
      resultMsg: req.query.msg || "",
      failMsg: req.query.fail || "",
      loadError: null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("promotion/index", {
      page: "students-promote",
      user: req.user,
      classes: [],
      sourceClass: "",
      students: [],
      allClasses: [],
      ok: false,
      resultMsg: "",
      failMsg: "",
      loadError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

// ── Step 2: preview changes before confirming ─────────────────────
router.post("/students/promote/preview", requireAdminOrManager(), async (req, res) => {
  try {
    const { sourceClassId, promotions: rawPromotions } = req.body;

    // Parse promotions — accept either JSON body or form-encoded.
    let promotions = rawPromotions;
    if (typeof promotions === "string") {
      try { promotions = JSON.parse(promotions); } catch (_e) { promotions = []; }
    }
    if (!Array.isArray(promotions) || promotions.length === 0) {
      return res.redirect("/students/promote?sourceClass=" + encodeURIComponent(sourceClassId || ""));
    }

    // Re-fetch each student server-side to prevent client-side tampering.
    const studentIds = promotions.map((p) => p.studentId).filter(Boolean);
    const students = await Student.find({ _id: { $in: studentIds } })
      .populate("classLevel", "name")
      .select("name rollNumber classLevel")
      .lean();

    const studentMap = new Map(students.map((s) => [String(s._id), s]));

    // Fetch all classes for display names.
    const allClasses = await ClassLevel.find().select("name").lean();
    const classMap = new Map(allClasses.map((c) => [String(c._id), c.name]));

    // Build the verified change list.
    const changes = [];
    for (const promo of promotions) {
      const student = studentMap.get(String(promo.studentId));
      if (!student) continue;

      const isGraduate = promo.action === "graduate";
      changes.push({
        studentId: String(student._id),
        name: student.name,
        rollNumber: student.rollNumber,
        currentClassName: student.classLevel ? student.classLevel.name : "Unknown",
        targetClassName: isGraduate ? "Graduated" : (classMap.get(promo.action) || "Unknown"),
        action: promo.action,
        isGraduate,
      });
    }

    if (changes.length === 0) {
      return res.redirect("/students/promote?sourceClass=" + encodeURIComponent(sourceClassId || ""));
    }

    res.render("promotion/preview", {
      page: "students-promote",
      user: req.user,
      changes,
      sourceClassId: sourceClassId || "",
      promotionsJson: JSON.stringify(promotions),
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    return res.redirect("/students/promote?error=" + encodeURIComponent(err.message));
  }
});

// ── Step 3: confirm and apply promotions ──────────────────────────
router.post("/students/promote/confirm", requireAdminOrManager(), async (req, res) => {
  try {
    const { promotions: rawPromotions } = req.body;

    let promotions = rawPromotions;
    if (typeof promotions === "string") {
      try { promotions = JSON.parse(promotions); } catch (_e) { promotions = []; }
    }

    if (!Array.isArray(promotions) || promotions.length === 0) {
      return res.redirect("/students/promote");
    }

    const result = await executePromotion(promotions, req.user._id);

    const msg = result.successCount + " student(s) promoted successfully.";
    const fail = result.failCount > 0
      ? result.failCount + " failed: " + result.failures.map((f) => f.name + " (" + f.error + ")").join("; ")
      : "";

    return res.redirect(
      "/students/promote?ok=1&msg=" + encodeURIComponent(msg) +
      (fail ? "&fail=" + encodeURIComponent(fail) : "")
    );
  } catch (err) {
    return res.redirect("/students/promote?error=" + encodeURIComponent(err.message));
  }
});

module.exports = router;
