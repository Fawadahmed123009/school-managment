const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

router.get("/attendance/rollup", requireRole("admin"), async (req, res) => {
  const now = new Date();
  const year = req.query.year || now.getFullYear();
  const month = req.query.month || now.getMonth() + 1;

  const result = await apiFetch(`/attendance/rollup?year=${year}&month=${month}`, req.token);

  res.render("attendance/rollup", {
    page: "attendance-rollup",
    user: req.user,
    year: Number(year),
    month: Number(month),
    rollup: result.status === "success" ? result.data : {},
    loadError: result.status === "success" ? null : result.message,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
