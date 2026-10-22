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

// Submit marks for a specific test — guarded by assignment check.
// The handler is wrapped end-to-end: a malformed/missing `records` body (e.g. a
// stale cached page posting an empty field) or an unexpected apiFetch rejection
// must redirect back with a readable message, NOT throw — otherwise the async
// error boundary turns it into a raw 500 "Internal server error" page.
router.post(
  "/tests/mark/:testId",
  requireRole("teacher"),
  isAssignedToTestView,
  async (req, res) => {
    const failBack = (message) =>
      res.redirect(
        `/tests/mark/${req.params.testId}?error=${encodeURIComponent(
          message || "Could not save the scores. Please try again."
        )}`
      );

    let parsed;
    try {
      const { records } = req.body;
      if (typeof records !== "string" || records.trim() === "") {
        return failBack("No scores were received. Please reload the page and try again.");
      }
      parsed = JSON.parse(records);
    } catch (err) {
      return failBack("The scores payload was invalid. Please reload the page and try again.");
    }

    const result = await apiFetch(`/tests/${req.params.testId}/results`, req.token, {
      method: "POST",
      body: JSON.stringify({ records: parsed }),
    }).catch((err) => ({ status: "failed", message: err && err.message }));

    if (!result || result.status !== "success") {
      return failBack(result && result.message);
    }
    res.redirect(`/tests/mark/${req.params.testId}?ok=1`);
  }
);

// NOTE: Editing the test's total/pass marks is now done in-page via a
// client-side PATCH to /api/v1/tests/:testId/marks (see public/js/test-scores.js
// and views/tests/roster.ejs). The old POST /tests/mark/:testId/settings view
// route was retired — it forced a full reload that wiped unsaved scores.

module.exports = router;
