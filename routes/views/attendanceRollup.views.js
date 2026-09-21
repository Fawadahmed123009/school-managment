const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");

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

// ── Admin rollup page (unified filter interface) ────────────────────────────

router.get("/attendance/rollup", requireAdminOrManager(), async (req, res) => {
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

  // ── Scope ──
  const scope = req.query.scope || "institute"; // institute | class | student
  const classLevel = req.query.classLevel || "";

  // ── Build class list (needed for class dropdown + student-scope filter) ──
  const classesRes = await apiFetch("/class-levels", req.token);
  const classes = classesRes.status === "success" ? classesRes.data : [];

  // ── Build API fetches based on scope + range combination ──
  const fetches = [];
  let fetchTypes = [];

  if (scope === "institute" || scope === "class") {
    if (isSingleDay) {
      // Snapshot: daily rollup gives one day's totals
      const classParam = scope === "class" && classLevel ? `&classLevel=${classLevel}` : "";
      fetches.push(apiFetch(`/attendance/daily-rollup?startDate=${startDate}&endDate=${endDate}${classParam}`, req.token));
      fetchTypes.push("snapshot");
    } else {
      // Multi-day: trend line chart
      const classParam = scope === "class" && classLevel ? `&classLevel=${classLevel}` : "";
      fetches.push(apiFetch(`/attendance/daily-rollup?startDate=${startDate}&endDate=${endDate}${classParam}`, req.token));
      fetchTypes.push("trend");

      // For whole-institute multi-day: ALSO fetch per-class comparison
      if (scope === "institute") {
        fetches.push(apiFetch(`/attendance/rollup?startDate=${startDate}&endDate=${endDate}`, req.token));
        fetchTypes.push("perClass");
      }
    }
  } else if (scope === "student") {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    params.set("endDate", endDate);
    if (classLevel) params.set("classLevel", classLevel);
    if (req.query.rollNumber) params.set("rollNumber", req.query.rollNumber);
    if (req.query.name) params.set("name", req.query.name);
    if (req.query.studentId) params.set("studentId", req.query.studentId);
    if (req.query.sortBy) params.set("sortBy", req.query.sortBy);
    fetches.push(apiFetch(`/attendance/student-history?${params.toString()}`, req.token));
    fetchTypes.push("student");
  }

  const results = fetches.length > 0 ? await Promise.all(fetches) : [];

  // ── Extract response data ──
  let dailyRollup = [];
  let rollup = {};
  let studentSearch = { students: [], history: null, summary: null };
  let loadError = null;

  if (scope === "institute" || scope === "class") {
    if (isSingleDay) {
      const dataRes = results[0];
      if (dataRes && dataRes.status === "success") dailyRollup = dataRes.data;
      else if (dataRes) loadError = dataRes.message;
    } else {
      const trendRes = results[0];
      if (trendRes && trendRes.status === "success") dailyRollup = trendRes.data;
      else if (trendRes) loadError = trendRes.message;

      if (scope === "institute" && results[1]) {
        const classRes = results[1];
        if (classRes.status === "success") rollup = classRes.data;
        else if (!loadError) loadError = classRes.message;
      }
    }
  } else if (scope === "student") {
    const dataRes = results[0];
    if (dataRes && dataRes.status === "success") studentSearch = dataRes.data;
    else if (dataRes) loadError = dataRes.message;
  }

  res.render("attendance/rollup", {
    page: "attendance-rollup",
    user: req.user,
    rangeType,
    startDate,
    endDate,
    isSingleDay,
    scope,
    classLevel,
    classes,
    dailyRollup,
    rollup,
    studentSearch,
    filters: {
      rollNumber: req.query.rollNumber || "",
      name: req.query.name || "",
      studentId: req.query.studentId || "",
      sortBy: req.query.sortBy || "",
    },
    // Week picker value (for re-populating the form)
    weekStartValue: rangeType === "week" ? startDate : "",
    // Year/month values (for re-populating the month-range form)
    year: Number(req.query.year || now.getFullYear()),
    month: Number(req.query.month || now.getMonth() + 1),
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
