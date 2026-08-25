const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const { apiFetch, BASE_URL } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

// Temp upload (view route) — the permanent save happens on the API side via
// its own diskStorage, mirroring the proven OCR multipart-proxy pattern.
const upload = multer({ dest: "uploads/" });

// Camera capture / photo page
router.get("/students/:studentId/photo", requireRole("admin"), async (req, res) => {
  const studentRes = await apiFetch(`/${req.params.studentId}/admin`, req.token);
  if (studentRes.status !== "success") {
    return res.redirect(`/students?error=${encodeURIComponent(studentRes.message || "Student not found")}`);
  }
  res.render("students/photo", {
    page: "students",
    user: req.user,
    student: studentRes.data,
    ok: req.query.ok === "1",
    photoError: req.query.error || null,
    schoolName: res.locals.schoolName,
  });
});

// Receive a captured/uploaded photo, proxy to the API with native FormData/Blob
// (NOT the form-data npm package — that silently truncated bodies here).
// Respond JSON for the in-page camera JS; redirect for the plain-form fallback.
router.post("/students/:studentId/photo", requireRole("admin"), upload.single("photo"), async (req, res) => {
  const isAjax = req.xhr || (req.headers.accept || "").includes("application/json");

  const finish = (result) => {
    if (isAjax) return res.json(result);
    if (result.status === "success") {
      res.redirect(`/students/${req.params.studentId}/photo?ok=1`);
    } else {
      res.redirect(`/students/${req.params.studentId}/photo?error=${encodeURIComponent(result.message || "Upload failed")}`);
    }
  };

  try {
    if (!req.file) return finish({ status: "failed", message: "No image provided" });

    const fileBuffer = fs.readFileSync(req.file.path);
    const form = new FormData();
    form.append("photo", new Blob([fileBuffer], { type: req.file.mimetype }), req.file.originalname || "capture.jpg");

    const apiResp = await fetch(`${BASE_URL}/students/${req.params.studentId}/photo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${req.token}` },
      body: form,
    });
    fs.unlink(req.file.path, () => {});

    const ctype = apiResp.headers.get("content-type") || "";
    if (!ctype.includes("application/json")) {
      return finish({ status: "failed", message: `Unexpected response (${apiResp.status}) from photo API` });
    }
    return finish(await apiResp.json());
  } catch (err) {
    return finish({ status: "failed", message: err.message });
  }
});

module.exports = router;
