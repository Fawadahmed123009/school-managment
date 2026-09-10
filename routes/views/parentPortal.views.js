const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const { apiFetch } = require("../../utils/apiClient");
const { THRESHOLDS } = require("../../services/alerts/atRiskAlerts.service");

// ── Helper: compute alert flags from a child's analysis data ──
function computeChildAlerts(analysis, thresholds) {
  if (!analysis) return null;
  const alerts = [];

  // Attendance alert
  const attPercent = analysis.attendance && analysis.attendance.percent;
  if (attPercent !== null && attPercent < thresholds.ATTENDANCE) {
    alerts.push({
      type: "attendance",
      message: `Attendance is at ${attPercent}%`,
      value: attPercent,
    });
  }

  // Per-subject score alerts
  if (analysis.marks && analysis.marks.bySubject) {
    analysis.marks.bySubject.forEach((s) => {
      if (s.average < thresholds.SCORE) {
        alerts.push({
          type: "score",
          message: `${s.average}% avg in ${s.subject}`,
          value: s.average,
          subject: s.subject,
        });
      }
    });
  }

  return alerts;
}

// ---- Parent Dashboard ----
router.get("/parent-portal", requireRole("parent"), async (req, res) => {
  const result = await apiFetch("/parents/profile", req.token);
  const profile = result.status === "success" ? result.data : null;

  // Fetch per-child analysis data for alert badges
  let childAlerts = {};
  if (profile && profile.children && profile.children.length > 0) {
    const analyses = await Promise.all(
      profile.children.map((child) => apiFetch(`/parents/children/${child._id}/analysis`, req.token))
    );
    profile.children.forEach((child, i) => {
      const analysis = analyses[i] && analyses[i].status === "success" ? analyses[i].data : null;
      childAlerts[child._id.toString()] = computeChildAlerts(analysis, THRESHOLDS);
    });
  }

  res.render("parents/dashboard", {
    page: "parent-dashboard",
    user: req.user,
    profile,
    childAlerts,
    alertThresholds: THRESHOLDS,
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
    alertThresholds: THRESHOLDS,
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
