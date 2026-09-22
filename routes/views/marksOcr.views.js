const express = require("express");
const router = express.Router();
const multer = require("multer");
const { apiFetch, BASE_URL } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");
const { verifyCsrf } = require("../../middlewares/csrf");
const { matchStudent } = require("../../utils/fuzzyMatch");
const Student = require("../../models/Students/students.model");
const { archiveOcrScan } = require("../../services/fees/ocrScanArchive.service");
const registerOcrScanViewRouter = require("./ocrScanRoute");
const fs = require("fs");
const upload = multer({ dest: "uploads/" });

// Auth-gated viewer for archived marks-scan photos (R2 marks-scans/ prefix).
registerOcrScanViewRouter(router, { pattern: "/marks/ocr/scan", role: "teacher" });

/** Fetch every student (id + name + class + roll#) for OCR dropdowns / fuzzy matching. */
const fetchAllStudents = () =>
  Student.find({}).select("_id name rollNumber").populate("classLevel", "name").sort("name").lean();

router.get("/marks/ocr", requireRole("teacher"), async (req, res) => {
  // Fetch only the classes this teacher is assigned to (cascade level 1)
  const [students, classesRes] = await Promise.all([
    fetchAllStudents(),
    apiFetch("/tests/cascade/classes", req.token),
  ]);
  const classes = classesRes.status === "success" ? classesRes.data : [];

  res.render("marks/ocr", {
    page: "marks-ocr",
    user: req.user,
    students,
    classes,
    schoolName: res.locals.schoolName,
  });
});

router.post("/marks/ocr/extract", requireRole("teacher"), upload.single("image"), verifyCsrf, async (req, res) => {
  try {
    if (!req.file) return res.json({ status: "failed", message: "No image uploaded" });
    const fileBuffer = fs.readFileSync(req.file.path);

    // Keep the scan photo in the cloud archive (R2 "marks-scans/" directory).
    // Best-effort: a storage failure must not block the OCR flow.
    let archivedUrl = null;
    try {
      const archived = await archiveOcrScan("marks", fileBuffer);
      archivedUrl = archived && archived.url;
    } catch (archiveErr) {
      console.error("marks scan archive failed:", archiveErr.message);
    }

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
    const students = await fetchAllStudents();
    const enriched = data.data.map((row) => {
      const match = matchStudent(row.name, students);
      return { ...row, ...match };
    });
    res.json({ status: "success", data: enriched, archivedUrl: archivedUrl || undefined });
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
