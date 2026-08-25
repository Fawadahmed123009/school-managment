const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

router.get("/attendance", requireRole("teacher"), async (req, res) => {
  const classesRes = await apiFetch("/class-levels", req.token);
  res.render("attendance/pick-class", {
    page: "attendance",
    user: req.user,
    classes: classesRes.status === "success" ? classesRes.data : [],
    loadError: classesRes.status === "success" ? null : classesRes.message,
    schoolName: res.locals.schoolName,
  });
});

router.get("/attendance/mark/:classLevelId", requireRole("teacher"), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const [rosterRes, classesRes] = await Promise.all([
    apiFetch(`/attendance/roster/${req.params.classLevelId}?date=${date}`, req.token),
    apiFetch("/class-levels", req.token),
  ]);

  const classDoc = (classesRes.status === "success" ? classesRes.data : []).find(
    (c) => c._id === req.params.classLevelId
  );

  res.render("attendance/mark", {
    page: "attendance",
    user: req.user,
    ok: req.query.ok === "1",
    classLevelId: req.params.classLevelId,
    className: classDoc ? classDoc.name : "Class",
    date,
    roster: rosterRes.status === "success" ? rosterRes.data : [],
    loadError: rosterRes.status === "success" ? null : rosterRes.message,
    schoolName: res.locals.schoolName,
  });
});

router.post("/attendance/mark/:classLevelId", requireRole("teacher"), async (req, res) => {
  const { date, records } = req.body;
  // records arrives as a JSON string from a hidden input, built client-side
  const parsed = JSON.parse(records);

  const result = await apiFetch("/attendance", req.token, {
    method: "POST",
    body: JSON.stringify({ classLevel: req.params.classLevelId, date, records: parsed }),
  });

  if (result.status !== "success") {
    return res.redirect(`/attendance/mark/${req.params.classLevelId}?date=${date}&error=${encodeURIComponent(result.message)}`);
  }

  res.redirect(`/attendance/mark/${req.params.classLevelId}?date=${date}&ok=1`);
});

module.exports = router;
