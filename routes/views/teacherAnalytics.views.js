const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

router.get("/teacher/analytics", requireRole("teacher"), async (req, res) => {
  // Cascade filters: Session → Grade → Phase → Week → Subject → Test.
  // Every field is optional ("All …" = empty value).
  const { sessionId, grade, phase, week, subject, testId } = req.query;

  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  if (grade) params.set("grade", grade);
  if (phase) params.set("phase", phase);
  if (week) params.set("week", week);
  if (subject) params.set("subject", subject);
  if (testId) params.set("testId", testId);

  const dataRes = await apiFetch(`/tests/teacher-analytics?${params.toString()}`, req.token);
  const data = dataRes.status === "success" ? dataRes.data : {};

  res.render("tests/teacher-analytics", {
    page: "teacher-analytics",
    user: req.user,
    classes: data.classes || [],
    subjects: data.subjects || [],
    sessions: data.sessions || [],
    testSnapshot: data.testSnapshot || [],
    perClass: data.perClass || [],
    perSession: data.perSession || [],
    overallStats: data.overallStats || null,
    loadError: dataRes.status === "success" ? null : dataRes.message,
    filters: {
      sessionId: sessionId || "",
      grade: grade || "",
      phase: phase || "",
      week: week || "",
      subject: subject || "",
      testId: testId || "",
    },
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
