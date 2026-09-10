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

module.exports = router;
