const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");

router.get("/tests/:testId/result-sheet", requireAdminOrManager(), async (req, res) => {
  const result = await apiFetch(`/tests/${req.params.testId}/result-sheet`, req.token);

  res.render("tests/result-sheet", {
    page: "tests-manage",
    user: req.user,
    test: result.status === "success" ? result.data.test : null,
    results: result.status === "success" ? result.data.results : [],
    loadError: result.status === "success" ? null : result.message,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
