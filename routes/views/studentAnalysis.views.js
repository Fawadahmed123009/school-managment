const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

// Admin views any student's analysis
router.get("/students/:studentId/analysis", requireRole("admin"), async (req, res) => {
  const result = await apiFetch(`/students/${req.params.studentId}/analysis`, req.token);

  res.render("students/analysis", {
    page: "students",
    user: req.user,
    analysis: result.status === "success" ? result.data : null,
    loadError: result.status === "success" ? null : result.message,
    schoolName: res.locals.schoolName,
  });
});

// Student views their own analysis
router.get("/my/analysis", requireRole("student"), async (req, res) => {
  const result = await apiFetch(`/students/${req.user._id}/analysis`, req.token);

  res.render("students/analysis", {
    page: "my-analysis",
    user: req.user,
    analysis: result.status === "success" ? result.data : null,
    loadError: result.status === "success" ? null : result.message,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
