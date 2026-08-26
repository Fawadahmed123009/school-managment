const express = require("express");
const router = express.Router();
const multer = require("multer");
const { apiFetch, BASE_URL } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");
const { verifyCsrf } = require("../../middlewares/csrf");
const fs = require("fs");

const upload = multer({ dest: "uploads/" });

router.get("/students/import", requireRole("admin"), async (req, res) => {
  const classesRes = await apiFetch("/class-levels", req.token);
  res.render("students/import", {
    page: "students-import",
    user: req.user,
    classes: classesRes.status === "success" ? classesRes.data : [],
    schoolName: res.locals.schoolName,
  });
});

router.post("/students/import/parse", requireRole("admin"), upload.single("file"), verifyCsrf, async (req, res) => {
  try {
    if (!req.file) return res.json({ status: "failed", message: "No file uploaded" });

    const fileBuffer = fs.readFileSync(req.file.path);
    const form = new FormData();
    form.append("file", new Blob([fileBuffer]), req.file.originalname);

    const parseRes = await fetch(`${BASE_URL}/students/import/parse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${req.token}` },
      body: form,
    });
    const data = await parseRes.json();
    fs.unlink(req.file.path, () => {});

    res.json(data);
  } catch (err) {
    res.json({ status: "failed", message: err.message });
  }
});

router.post("/students/import/confirm", requireRole("admin"), async (req, res) => {
  const { students } = req.body;
  const result = await apiFetch("/students/import/confirm", req.token, {
    method: "POST",
    body: JSON.stringify({ students }),
  });
  res.json(result);
});

module.exports = router;
