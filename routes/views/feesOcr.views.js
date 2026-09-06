const express = require("express");
const router = express.Router();
const multer = require("multer");
const { apiFetch, BASE_URL } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");
const { verifyCsrf } = require("../../middlewares/csrf");
const { matchStudent } = require("../../utils/fuzzyMatch");
const Student = require("../../models/Students/students.model");
const fs = require("fs");

const upload = multer({ dest: "uploads/" });

/** Fetch every student (id + name + class + roll#) for OCR dropdowns / fuzzy matching. */
const fetchAllStudents = () =>
  Student.find({}).select("_id name rollNumber").populate("classLevel", "name").sort("name").lean();

router.get("/fees/ocr", requireRole("admin"), async (req, res) => {
  const students = await fetchAllStudents();
  res.render("fees/ocr", {
    page: "fees-ocr",
    user: req.user,
    students,
    schoolName: res.locals.schoolName,
  });
});

router.post("/fees/ocr/extract", requireRole("admin"), upload.single("image"), verifyCsrf, async (req, res) => {
  try {
    if (!req.file) return res.json({ status: "failed", message: "No image uploaded" });

    const fileBuffer = fs.readFileSync(req.file.path);
    const form = new FormData();
    form.append("image", new Blob([fileBuffer], { type: req.file.mimetype }), req.file.originalname);

    const extractRes = await fetch(`${BASE_URL}/fees/ocr/extract`, {
      method: "POST",
      headers: { Authorization: `Bearer ${req.token}` },
      body: form,
    });
    const data = await extractRes.json();
    fs.unlink(req.file.path, () => {});

    if (data.status !== "success") return res.json(data);

    const students = await fetchAllStudents();

    const enriched = data.data.map((row) => {
      const match = matchStudent(row.name, students);
      return { ...row, ...match };
    });

    res.json({ status: "success", data: enriched });
  } catch (err) {
    res.json({ status: "failed", message: err.message });
  }
});

router.post("/fees/ocr/confirm", requireRole("admin"), async (req, res) => {
  const { fees } = req.body;
  const result = await apiFetch("/fees/bulk", req.token, {
    method: "POST",
    body: JSON.stringify({ fees }),
  });
  res.json(result);
});

router.post("/fees/ocr/resolve/:feeId", requireRole("admin"), verifyCsrf, async (req, res) => {
  const result = await apiFetch(`/fees/ocr/resolve/${req.params.feeId}`, req.token, {
    method: "POST",
    body: JSON.stringify({}),
  });
  res.json(result);
});

module.exports = router;
