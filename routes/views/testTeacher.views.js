const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");
const { isAssignedToTestView } = require("../../middlewares/isAssignedToSubject");

// Teacher test list — uses three-level cascade: Class → Subject → Test
router.get("/tests/mark", requireRole("teacher"), async (req, res) => {
  // Fetch only the classes this teacher is assigned to (cascade level 1)
  const classesRes = await apiFetch("/tests/cascade/classes", req.token);
  const classes = classesRes.status === "success" ? classesRes.data : [];

  res.render("tests/pick", {
    page: "tests-mark",
    user: req.user,
    classes,
    loadError: classesRes.status === "success" ? null : classesRes.message,
    schoolName: res.locals.schoolName,
  });
});

// Mark-entry page for a specific test — guarded by assignment check
router.get(
  "/tests/mark/:testId",
  requireRole("teacher"),
  isAssignedToTestView,
  async (req, res) => {
    const result = await apiFetch(`/tests/${req.params.testId}/roster`, req.token);

    res.render("tests/roster", {
      page: "tests-mark",
      user: req.user,
      ok: req.query.ok === "1",
      error: req.query.error ? String(req.query.error) : "",
      testId: req.params.testId,
      test: result.status === "success" ? result.data.test : null,
      roster: result.status === "success" ? result.data.roster : [],
      loadError: result.status === "success" ? null : result.message,
      schoolName: res.locals.schoolName,
    });
  }
);

// Submit marks for a specific test — guarded by assignment check
router.post(
  "/tests/mark/:testId",
  requireRole("teacher"),
  isAssignedToTestView,
  async (req, res) => {
    const { records } = req.body;
    const parsed = JSON.parse(records);

    const result = await apiFetch(`/tests/${req.params.testId}/results`, req.token, {
      method: "POST",
      body: JSON.stringify({ records: parsed }),
    });

    if (result.status !== "success") {
      return res.redirect(`/tests/mark/${req.params.testId}?error=${encodeURIComponent(result.message)}`);
    }
    res.redirect(`/tests/mark/${req.params.testId}?ok=1`);
  }
);

// NOTE: Editing the test's total/pass marks is now done in-page via a
// client-side PATCH to /api/v1/tests/:testId/marks (see public/js/test-scores.js
// and views/tests/roster.ejs). The old POST /tests/mark/:testId/settings view
// route was retired — it forced a full reload that wiped unsaved scores.

module.exports = router;
