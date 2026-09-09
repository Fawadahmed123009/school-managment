const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");

router.get("/attendance/rollup", requireAdminOrManager(), async (req, res) => {
  const now = new Date();
  const year = req.query.year || now.getFullYear();
  const month = req.query.month || now.getMonth() + 1;
  const tab = req.query.tab || "class"; // class | daily | student
  const classLevel = req.query.classLevel || "";

  // Build parallel fetches depending on active tab
  const fetches = [
    apiFetch("/class-levels", req.token),
  ];

  if (tab === "class") {
    fetches.push(apiFetch(`/attendance/rollup?year=${year}&month=${month}`, req.token));
  } else if (tab === "daily") {
    const classParam = classLevel ? `&classLevel=${classLevel}` : "";
    fetches.push(apiFetch(`/attendance/daily-rollup?year=${year}&month=${month}${classParam}`, req.token));
  } else if (tab === "student") {
    const params = new URLSearchParams();
    if (classLevel) params.set("classLevel", classLevel);
    if (req.query.rollNumber) params.set("rollNumber", req.query.rollNumber);
    if (req.query.name) params.set("name", req.query.name);
    if (req.query.studentId) params.set("studentId", req.query.studentId);
    fetches.push(apiFetch(`/attendance/student-history?${params.toString()}`, req.token));
  }

  const results = await Promise.all(fetches);
  const classesRes = results[0];
  const dataRes = results[1];

  const classes = classesRes.status === "success" ? classesRes.data : [];

  // Defaults for each tab's data
  let rollup = {};
  let dailyRollup = [];
  let studentSearch = { students: [], history: null, summary: null };
  let loadError = null;

  if (tab === "class") {
    if (dataRes && dataRes.status === "success") {
      rollup = dataRes.data;
    } else if (dataRes) {
      loadError = dataRes.message;
    }
  } else if (tab === "daily") {
    if (dataRes && dataRes.status === "success") {
      dailyRollup = dataRes.data;
    } else if (dataRes) {
      loadError = dataRes.message;
    }
  } else if (tab === "student") {
    if (dataRes && dataRes.status === "success") {
      studentSearch = dataRes.data;
    } else if (dataRes) {
      loadError = dataRes.message;
    }
  }

  res.render("attendance/rollup", {
    page: "attendance-rollup",
    user: req.user,
    year: Number(year),
    month: Number(month),
    tab,
    classLevel,
    classes,
    rollup,
    dailyRollup,
    studentSearch,
    filters: {
      rollNumber: req.query.rollNumber || "",
      name: req.query.name || "",
      studentId: req.query.studentId || "",
    },
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
