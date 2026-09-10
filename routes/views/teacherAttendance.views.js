const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

router.get("/attendance/my-classes", requireRole("teacher"), async (req, res) => {
  const now = new Date();
  const year = req.query.year || now.getFullYear();
  const month = req.query.month || now.getMonth() + 1;
  const tab = req.query.tab || "class";
  const classLevel = req.query.classLevel || "";

  // Build query params for the API call
  const params = new URLSearchParams();
  params.set("year", year);
  params.set("month", month);
  if (classLevel) params.set("classLevel", classLevel);

  const dataRes = await apiFetch(`/attendance/teacher-view?${params.toString()}`, req.token);
  const data = dataRes.status === "success" ? dataRes.data : {};

  res.render("attendance/teacher-view", {
    page: "attendance-view",
    user: req.user,
    year: Number(year),
    month: Number(month),
    tab,
    classLevel,
    classes: data.classes || [],
    perClass: data.perClass || [],
    perStudent: data.perStudent || [],
    loadError: dataRes.status === "success" ? null : dataRes.message,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
