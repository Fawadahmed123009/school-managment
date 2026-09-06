const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

router.get("/tests/analytics", requireRole("admin"), async (req, res) => {
  const { testId, classLevelId, subjectId, nameSearch, rollNumberSearch, viewMode, mode, studentId } = req.query;

  // ── Trend mode ──────────────────────────────────────────────────────────
  if (viewMode === "trend") {
    const params = new URLSearchParams();
    params.set("mode", mode || "");
    if (studentId) params.set("studentId", studentId);
    if (classLevelId) params.set("classLevelId", classLevelId);
    if (subjectId) params.set("subjectId", subjectId);

    const trendRes = await apiFetch(`/tests/analytics/trend?${params.toString()}`, req.token);
    const data = trendRes.status === "success" ? trendRes.data : {};

    return res.render("tests/analytics", {
      page: "tests-analytics",
      user: req.user,
      viewMode: "trend",
      trendMode: data.mode || mode || null,
      trendLines: data.trend || [],
      trendTableRows: data.tableRows || [],
      students: data.students || [],
      classes: data.classes || [],
      subjects: data.subjects || [],
      tests: [],
      current: null,
      previous: null,
      distribution: [],
      resultRows: [],
      resultCount: 0,
      loadError: trendRes.status === "success" ? null : trendRes.message,
      filters: { testId: "", classLevelId, subjectId, nameSearch: "", rollNumberSearch: "", viewMode: "trend", mode: mode || "", studentId: studentId || "" },
      hasFilters: false,
      schoolName: res.locals.schoolName,
    });
  }

  // ── Single-test mode (default) ──────────────────────────────────────────
  const params = new URLSearchParams();
  if (testId) params.set("testId", testId);
  if (classLevelId) params.set("classLevelId", classLevelId);
  if (subjectId) params.set("subjectId", subjectId);
  if (nameSearch) params.set("nameSearch", nameSearch);
  if (rollNumberSearch) params.set("rollNumberSearch", rollNumberSearch);

  const hasFilters = testId;

  const analyticsRes = hasFilters
    ? await apiFetch(`/tests/analytics/enhanced?${params.toString()}`, req.token)
    : await apiFetch("/tests/analytics/enhanced", req.token);

  const data = analyticsRes.status === "success" ? analyticsRes.data : {};

  res.render("tests/analytics", {
    page: "tests-analytics",
    user: req.user,
    viewMode: "single",
    trendMode: null,
    trendLines: [],
    trendTableRows: [],
    students: [],
    classes: data.classes || [],
    subjects: data.subjects || [],
    tests: data.tests || [],
    current: data.current || null,
    previous: data.previous || null,
    distribution: data.distribution || [],
    resultRows: data.resultRows || [],
    resultCount: data.resultCount || 0,
    loadError: analyticsRes.status === "success" ? null : analyticsRes.message,
    filters: { testId, classLevelId, subjectId, nameSearch, rollNumberSearch, viewMode: "single", mode: "", studentId: "" },
    hasFilters,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
