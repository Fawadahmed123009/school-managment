const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

// ── date helpers ────────────────────────────────────────────────────────────

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseLocalDate(str) {
  const [y, m, d] = String(str).split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Monday of the week containing dateStr
function mondayOf(dateStr) {
  const d = parseLocalDate(dateStr);
  const dow = d.getDay(); // 0 = Sun ... 6 = Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diff);
  return d;
}

// ── Teacher attendance page (unified filter interface) ──────────────────────

router.get("/attendance/my-classes", requireRole("teacher"), async (req, res) => {
  const now = new Date();
  const todayISO = toISODate(now);

  // ── Resolve rangeType → concrete startDate / endDate ──
  const rangeType = req.query.rangeType || "today"; // today | week | month | custom
  let startDate = "";
  let endDate = "";

  if (rangeType === "week") {
    const wkStart = mondayOf(req.query.weekStart || todayISO);
    const wkEnd = new Date(wkStart);
    wkEnd.setDate(wkEnd.getDate() + 6);
    startDate = toISODate(wkStart);
    endDate = toISODate(wkEnd);
  } else if (rangeType === "month") {
    const y = Number(req.query.year || now.getFullYear());
    const m = Number(req.query.month || now.getMonth() + 1);
    const first = new Date(y, m - 1, 1);
    const last = new Date(y, m, 0);
    startDate = toISODate(first);
    endDate = toISODate(last);
  } else if (rangeType === "custom") {
    let s = req.query.startDate || todayISO;
    let e = req.query.endDate || todayISO;
    if (parseLocalDate(e) < parseLocalDate(s)) [s, e] = [e, s];
    startDate = s;
    endDate = e;
  } else {
    // "today" (default)
    startDate = todayISO;
    endDate = todayISO;
  }

  const isSingleDay = startDate === endDate;

  // ── Scope (teacher: no "whole institute" option) ──
  const scope = req.query.scope || "myClasses"; // myClasses | specificClass | specificStudent
  const classLevel = req.query.classLevel || "";

  // ── Build API call ──
  const params = new URLSearchParams();
  params.set("startDate", startDate);
  params.set("endDate", endDate);
  params.set("scope", scope);
  if (classLevel) params.set("classLevel", classLevel);
  if (req.query.sortBy) params.set("sortBy", req.query.sortBy);
  if (req.query.studentId) params.set("studentId", req.query.studentId);

  const dataRes = await apiFetch(`/attendance/teacher-view?${params.toString()}`, req.token);
  const data = dataRes.status === "success" ? dataRes.data : {};

  res.render("attendance/teacher-view", {
    page: "attendance-view",
    user: req.user,
    rangeType,
    startDate,
    endDate,
    isSingleDay,
    scope,
    classLevel,
    sortBy: req.query.sortBy || "",
    classes: data.classes || [],
    perClass: data.perClass || [],
    dailyTrend: data.dailyTrend || [],
    perStudent: data.perStudent || [],
    studentHistory: data.studentHistory || null,
    filters: {
      studentId: req.query.studentId || "",
    },
    weekStartValue: rangeType === "week" ? startDate : "",
    year: Number(req.query.year || now.getFullYear()),
    month: Number(req.query.month || now.getMonth() + 1),
    loadError: dataRes.status === "success" ? null : dataRes.message,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
