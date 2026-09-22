const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

router.get("/teacher/analytics", requireRole("teacher"), async (req, res) => {
  const { classLevel, subject, sessionId, fromDate, toDate } = req.query;

  // The Class filter is a checkbox group → an array of class/grade tokens.
  // The API takes them as one comma-separated list.
  const classTokens = Array.isArray(classLevel)
    ? classLevel
    : classLevel
      ? String(classLevel).split(",")
      : [];

  // Build query params for the API call
  const params = new URLSearchParams();
  if (classTokens.length) params.set("classLevel", classTokens.join(","));
  if (subject) params.set("subject", subject);
  if (sessionId) params.set("sessionId", sessionId);
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);

  const dataRes = await apiFetch(`/tests/teacher-analytics?${params.toString()}`, req.token);
  const data = dataRes.status === "success" ? dataRes.data : {};

  res.render("tests/teacher-analytics", {
    page: "teacher-analytics",
    user: req.user,
    classes: data.classes || [],
    subjects: data.subjects || [],
    sessions: data.sessions || [],
    perClass: data.perClass || [],
    perSession: data.perSession || [],
    overallStats: data.overallStats || null,
    loadError: dataRes.status === "success" ? null : dataRes.message,
    filters: {
      classLevel: classLevel || "",
      classTokens,
      subject: subject || "",
      sessionId: sessionId || "",
      fromDate: fromDate || "",
      toDate: toDate || "",
    },
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
