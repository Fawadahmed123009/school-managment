const express = require("express");
const router = express.Router();
const multer = require("multer");
const { apiFetch, BASE_URL } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");
const { verifyCsrf } = require("../../middlewares/csrf");
const { matchStudent } = require("../../utils/fuzzyMatch");
const fs = require("fs");
const upload = multer({ dest: "uploads/" });

router.get("/marks/ocr", requireRole("teacher"), async (req, res) => {
  const [studentsRes, testsRes] = await Promise.all([
    apiFetch("/admin/students", req.token),
    apiFetch("/tests", req.token),
  ]);
  res.render("marks/ocr", {
    page: "marks-ocr",
    user: req.user,
    students: studentsRes.status === "success" ? (Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.data || []) : [],
    tests: testsRes.status === "success" ? testsRes.data : [],
    schoolName: res.locals.schoolName,
  });
});

router.post("/marks/ocr/extract", requireRole("teacher"), upload.single("image"), verifyCsrf, async (req, res) => {
  try {
    if (!req.file) return res.json({ status: "failed", message: "No image uploaded" });
    const fileBuffer = fs.readFileSync(req.file.path);
    const form = new FormData();
    form.append("image", new Blob([fileBuffer], { type: req.file.mimetype }), req.file.originalname);
    const extractRes = await fetch(`${BASE_URL}/marks/ocr/extract`, {
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

router.post("/marks/ocr/confirm", requireRole("teacher"), async (req, res) => {
  const { testId, records } = req.body;
  if (!testId) return res.json({ status: "failed", message: "No test selected" });

  const result = await apiFetch(`/tests/${testId}/results`, req.token, {
    method: "POST",
    body: JSON.stringify({ records }),
  });
  res.json(result);
});

module.exports = router;
