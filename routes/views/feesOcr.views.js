const express = require("express");
const router = express.Router();
const multer = require("multer");
const { apiFetch, BASE_URL } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");
const { verifyCsrf } = require("../../middlewares/csrf");
const { matchStudent } = require("../../utils/fuzzyMatch");
const fs = require("fs");

const upload = multer({ dest: "uploads/" });

router.get("/fees/ocr", requireRole("admin"), async (req, res) => {
  const studentsRes = await apiFetch("/admin/students", req.token);
  res.render("fees/ocr", {
    page: "fees-ocr",
    user: req.user,
    students: studentsRes.status === "success" ? (Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.data || []) : [],
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

    const studentsRes = await apiFetch("/admin/students", req.token);
    const students = studentsRes.status === "success" ? (Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.data || []) : [];

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

module.exports = router;
