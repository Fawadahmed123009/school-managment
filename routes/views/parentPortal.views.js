const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const { apiFetch } = require("../../utils/apiClient");

// ---- Parent Dashboard ----
router.get("/parent-portal", requireRole("parent"), async (req, res) => {
  const result = await apiFetch("/parents/profile", req.token);
  res.render("parents/dashboard", {
    page: "parent-dashboard",
    user: req.user,
    profile: result.status === "success" ? result.data : null,
    loadError: result.status === "success" ? null : result.message,
    schoolName: res.locals.schoolName,
  });
});

// ---- Child Analysis ----
router.get("/child/:childId/analysis", requireRole("parent"), async (req, res) => {
  const [analysisResult, profileResult] = await Promise.all([
    apiFetch(`/parents/children/${req.params.childId}/analysis`, req.token),
    apiFetch("/parents/profile", req.token),
  ]);

  const loadError =
    analysisResult.status !== "success"
      ? analysisResult.message
      : profileResult.status !== "success"
      ? profileResult.message
      : null;

  res.render("parents/childAnalysis", {
    page: "child-analysis",
    user: req.user,
    childId: req.params.childId,
    analysis: analysisResult.status === "success" ? analysisResult.data : null,
    profile: profileResult.status === "success" ? profileResult.data : null,
    loadError,
    schoolName: res.locals.schoolName,
  });
});

// ---- Child Fees ----
router.get("/child/:childId/fees", requireRole("parent"), async (req, res) => {
  const [feesResult, profileResult] = await Promise.all([
    apiFetch(`/parents/children/${req.params.childId}/fees`, req.token),
    apiFetch("/parents/profile", req.token),
  ]);

  const loadError =
    feesResult.status !== "success"
      ? feesResult.message
      : profileResult.status !== "success"
      ? profileResult.message
      : null;

  res.render("parents/childFees", {
    page: "child-fees",
    user: req.user,
    childId: req.params.childId,
    fees: feesResult.status === "success" && Array.isArray(feesResult.data) ? feesResult.data : [],
    profile: profileResult.status === "success" ? profileResult.data : null,
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
