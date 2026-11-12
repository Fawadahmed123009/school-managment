const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");
const { localDateKey } = require("../../utils/localDateKey");
const { formatMinutes } = require("../../utils/teacherAttendanceTime");

// ── date helpers (same convention as the other attendance view routers) ─────

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const safeDate = (str, fallback) => (DATE_RE.test(String(str)) ? str : fallback);

// ── Daily marking (manager/admin) ───────────────────────────────────────────

router.get("/teacher-attendance", requireAdminOrManager(), async (req, res) => {
  const todayISO = toISODate(new Date());
  const date = safeDate(req.query.date, todayISO);

  const dayRes = await apiFetch(`/teacher-attendance/day?date=${date}`, req.token);
  const day = dayRes.status === "success" ? dayRes.data : null;

  res.render("staff-attendance/mark", {
    page: "staff-attendance",
    user: req.user,
    date,
    todayISO,
    roster: day ? day.teachers : [],
    settings: day ? day.settings : { lateDetectionEnabled: false, startTime: "08:00", graceMinutes: 0 },
    summary: day ? day.summary : { marked: 0, totalTeachers: 0, totalMinutes: 0, lateCount: 0 },
    ok: req.query.ok === "1",
    error: req.query.error || "",
    loadError: dayRes.status === "success" ? null : dayRes.message,
    formatMinutes,
    schoolName: res.locals.schoolName,
  });
});

router.post("/teacher-attendance", requireAdminOrManager(), async (req, res) => {
  const date = safeDate(req.body.date, toISODate(new Date()));

  // records arrives as a JSON string from a hidden input, built client-side
  let records;
  try {
    records = JSON.parse(req.body.records || "[]");
  } catch (e) {
    return res.redirect(`/teacher-attendance?date=${date}&error=${encodeURIComponent("Invalid submission — please retry.")}`);
  }

  const result = await apiFetch("/teacher-attendance", req.token, {
    method: "POST",
    body: JSON.stringify({ date, records }),
  });

  if (result.status !== "success") {
    return res.redirect(`/teacher-attendance?date=${date}&error=${encodeURIComponent(result.message)}`);
  }
  res.redirect(`/teacher-attendance?date=${date}&ok=1`);
});

// ── History + working-hours totals (manager/admin) ──────────────────────────

router.get("/teacher-attendance/history", requireAdminOrManager(), async (req, res) => {
  const now = new Date();
  const monthFirst = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));
  const monthLast = toISODate(new Date(now.getFullYear(), now.getMonth() + 1, 0));

  let startDate = safeDate(req.query.startDate, monthFirst);
  let endDate = safeDate(req.query.endDate, monthLast);
  if (parseLocalDate(endDate) < parseLocalDate(startDate)) [startDate, endDate] = [endDate, startDate];
  const teacherId = req.query.teacherId || "";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const params = new URLSearchParams({ startDate, endDate, page: String(page), limit: "31" });
  if (teacherId) params.set("teacherId", teacherId);

  const [histRes, teachersRes] = await Promise.all([
    apiFetch(`/teacher-attendance/history?${params.toString()}`, req.token),
    apiFetch("/teacher-attendance/teachers", req.token),
  ]);

  const hist = histRes.status === "success" ? histRes.data : null;
  const teachers = teachersRes.status === "success" ? teachersRes.data : [];

  // Day keys MUST go through localDateKey — records sit at local midnight,
  // which is the previous UTC day (see utils/localDateKey.js).
  const records = hist
    ? hist.records.map((r) => ({
        ...r,
        dateKey: localDateKey(r.date),
        teacherName: r.teacher ? r.teacher.name : "Unknown",
        duration: formatMinutes(r.workingMinutes),
      }))
    : [];

  res.render("staff-attendance/history", {
    page: "staff-attendance-history",
    user: req.user,
    startDate,
    endDate,
    teacherId,
    teachers,
    records,
    pagination: hist ? hist.pagination : { total: 0, page: 1, pages: 0, hasPrev: false, hasNext: false },
    summary: hist ? hist.summary : { totalMinutes: 0, totalHours: 0, records: 0, lateCount: 0 },
    perTeacher: hist ? hist.perTeacher : [],
    loadError: histRes.status === "success" ? null : histRes.message,
    formatMinutes,
    schoolName: res.locals.schoolName,
  });
});

// ── Late-arrival rule (ADMIN only) ──────────────────────────────────────────

router.get("/teacher-attendance/settings", requireRole("admin"), async (req, res) => {
  const settingsRes = await apiFetch("/teacher-attendance/settings", req.token);
  const settings = settingsRes.status === "success"
    ? settingsRes.data
    : { lateDetectionEnabled: false, startTime: "08:00", graceMinutes: 0 };

  res.render("staff-attendance/settings", {
    page: "staff-attendance-settings",
    user: req.user,
    settings,
    ok: req.query.ok === "1",
    error: req.query.error || "",
    loadError: settingsRes.status === "success" ? null : settingsRes.message,
    schoolName: res.locals.schoolName,
  });
});

router.post("/teacher-attendance/settings", requireRole("admin"), async (req, res) => {
  const result = await apiFetch("/teacher-attendance/settings", req.token, {
    method: "PUT",
    body: JSON.stringify({
      // Unchecked checkboxes are absent from the form body → disabled.
      lateDetectionEnabled: req.body.lateDetectionEnabled === "on",
      startTime: req.body.startTime,
      graceMinutes: req.body.graceMinutes,
    }),
  });

  if (result.status !== "success") {
    return res.redirect(`/teacher-attendance/settings?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect("/teacher-attendance/settings?ok=1");
});

module.exports = router;