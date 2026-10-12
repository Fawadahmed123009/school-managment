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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const fmtPct = (v) => (v === null || v === undefined ? "—" : v + "%");

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

  let loadError = null;

  // ══════════════════════════════════════════════════════════════════
  // MY CLASSES / SPECIFIC CLASS SCOPE → teacher-scoped dashboard
  // (same aggregate flow as the admin/manager rollup, narrowed to the
  // teacher's assigned classes by /attendance/teacher-dashboard)
  // ══════════════════════════════════════════════════════════════════
  if (scope === "myClasses" || scope === "specificClass") {
    // Calendar month the range ends in — the Monthly Report card window
    const eD = parseLocalDate(endDate);
    const monthYear = eD.getFullYear();
    const monthNum = eD.getMonth() + 1;
    const monthFirst = toISODate(new Date(monthYear, monthNum - 1, 1));
    const monthLast = toISODate(new Date(monthYear, monthNum, 0));
    const monthLabel = `${MONTH_NAMES[monthNum - 1]} ${monthYear}`;

    // Class dropdown list — teacher-view returns exactly the assigned classes;
    // a single-day range keeps its aggregation trivial.
    const classParam = scope === "specificClass" && classLevel ? `&classLevel=${classLevel}` : "";
    const [classesRes, dashRes, monthRes] = await Promise.all([
      apiFetch(`/attendance/teacher-view?startDate=${todayISO}&endDate=${todayISO}&scope=myClasses`, req.token),
      apiFetch(`/attendance/teacher-dashboard?startDate=${startDate}&endDate=${endDate}${classParam}`, req.token),
      apiFetch(`/attendance/teacher-dashboard?startDate=${monthFirst}&endDate=${monthLast}${classParam}&breakdown=0`, req.token),
    ]);

    const classes = classesRes.status === "success" ? classesRes.data.classes || [] : [];
    if (classesRes.status !== "success") loadError = classesRes.message;

    let dash = null;
    if (dashRes.status === "success") dash = dashRes.data;
    else loadError = loadError || dashRes.message; // tampered classLevel → the API gate's 403 surfaces here

    // Monthly Report card (calendar month the range ends in, breakdown skipped)
    let monthly = null;
    if (monthRes.status === "success") {
      const m = monthRes.data;
      const rated = m.days.filter((d) => d.marked > 0);
      const avg = rated.length
        ? Math.round((rated.reduce((s, d) => s + (d.rate || 0), 0) / rated.length) * 10) / 10
        : null;
      monthly = {
        label: monthLabel,
        avgRate: avg,
        present: m.summary.present,
        absent: m.summary.absent,
        late: m.summary.late,
        markedDays: rated.length,
      };
    } else if (dash && !loadError) {
      loadError = monthRes.message;
    }

    // ── Incomplete-marking banner (teacher scope) ──
    // Single day (either dashboard scope): marked head-count vs enrolled.
    // Multi-day: only for "my classes" — mirrors the admin rule where the
    // class-scoped multi-day case is covered by class-wise flagging.
    let banner = null;
    if (dash && dash.enrolled > 0) {
      if (isSingleDay) {
        if (dash.summary.marked < dash.enrolled) {
          banner = { marked: dash.summary.marked, expected: dash.enrolled, singleDay: true };
        }
      } else if (scope === "myClasses" && dash.days.length > 0) {
        const expected = dash.enrolled * dash.days.length;
        if (dash.summary.marked < expected) {
          banner = { marked: dash.summary.marked, expected, singleDay: false };
        }
      }
    }

    // ── Weekly trend: 7 calendar days ending at the range's endDate ──
    const dayMap = {};
    if (dash) dash.days.forEach((d) => { dayMap[d.date] = d; });
    const weekly = [];
    for (let i = 6; i >= 0; i--) {
      const dt = parseLocalDate(endDate);
      dt.setDate(dt.getDate() - i);
      const key = toISODate(dt);
      const d = dayMap[key] || null;
      weekly.push({
        date: key,
        marked: d ? d.marked : 0,
        rate: d ? d.rate : null,
        // partial = day was marked but not everyone in scope got a record
        partial: !!(d && dash && d.marked < dash.enrolled),
        unmarked: !d,
      });
    }

    const classRows = dash ? dash.classes : [];

    // ── Insight tiles — same set as the admin dashboard, with the class-wise
    // tile dropped when there's fewer than two classes to compare (a
    // cross-class insight is meaningless for a teacher with one class).
    const insights = [];
    if (dash) {
      const s = dash.summary;

      let worstDay = null;
      dash.days.forEach((d) => {
        if (!worstDay || d.absent > worstDay.absent) worstDay = d;
      });

      const withData = classRows.filter((c) => c.marked > 0 && c.rate !== null);
      const incompleteCount = classRows.filter((c) => c.incomplete).length;
      const bestClass = withData.length ? withData.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;
      const worstClass = withData.length ? withData.reduce((a, b) => (b.rate < a.rate ? b : a)) : null;

      const rangeParams = `rangeType=custom&startDate=${startDate}&endDate=${endDate}`;

      insights.push({
        icon: "day",
        tone: "accent-blue",
        title: "Daily Summary",
        desc: isSingleDay
          ? `${fmtPct(s.rate)} attendance on ${startDate} — ${s.present} present, ${s.absent} absent, ${s.late} late`
          : `${fmtPct(s.rate)} over ${startDate} → ${endDate} — ${s.present} present, ${s.absent} absent, ${s.late} late`,
        href: "/attendance/my-classes?rangeType=today&scope=myClasses",
      });

      insights.push({
        icon: "month",
        tone: "accent-purple",
        title: "Monthly Trends",
        desc: monthly && monthly.avgRate !== null
          ? `${monthly.label}: avg ${fmtPct(monthly.avgRate)} across ${monthly.markedDays} marked day${monthly.markedDays === 1 ? "" : "s"}`
          : `No attendance recorded in ${monthLabel} yet`,
        href: `/attendance/my-classes?rangeType=month&year=${monthYear}&month=${monthNum}&scope=myClasses`,
      });

      insights.push({
        icon: "absent",
        tone: "accent-red",
        title: "Absence Analysis",
        desc: s.marked > 0
          ? `${s.absent} absences (${Math.round((s.absent / s.marked) * 100)}% of marked)` +
            (worstDay && worstDay.absent > 0 ? ` · worst day ${worstDay.date} with ${worstDay.absent}` : "")
          : "No attendance marked for this range",
        href: `/attendance/my-classes?${rangeParams}&scope=specificStudent`,
      });

      insights.push({
        icon: "late",
        tone: "accent-gold",
        title: "Late Arrivals",
        desc: s.marked > 0
          ? `${s.late} late arrival${s.late === 1 ? "" : "s"} (${Math.round((s.late / s.marked) * 100)}% of marked records)`
          : "No attendance marked for this range",
        href: `/attendance/my-classes?${rangeParams}&scope=specificStudent`,
      });

      if (scope === "myClasses" && classRows.length > 1) {
        insights.push({
          icon: "class",
          tone: "accent-green",
          title: "Class-wise Insights",
          desc: `${incompleteCount} of ${classRows.length} of my classes incomplete` +
            (bestClass && worstClass ? ` · top ${bestClass.name} ${fmtPct(bestClass.rate)}, low ${worstClass.name} ${fmtPct(worstClass.rate)}` : ""),
          href: `/attendance/my-classes?${rangeParams}&scope=specificClass`,
        });
      }
    }

    return res.render("attendance/teacher-view", {
      page: "attendance-view",
      user: req.user,
      rangeType,
      startDate,
      endDate,
      isSingleDay,
      scope,
      classLevel,
      classes,
      dash,
      banner,
      weekly,
      monthly,
      classRows,
      insights,
      // Student-scope vars kept for the shared template branches
      perClass: [],
      dailyTrend: [],
      perStudent: [],
      studentHistory: null,
      sortBy: req.query.sortBy || "",
      filters: { studentId: req.query.studentId || "" },
      weekStartValue: rangeType === "week" ? startDate : "",
      year: Number(req.query.year || now.getFullYear()),
      month: Number(req.query.month || now.getMonth() + 1),
      loadError,
      schoolName: res.locals.schoolName,
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // SPECIFIC STUDENT SCOPE — unchanged list + history flow
  // ══════════════════════════════════════════════════════════════════
  const params = new URLSearchParams();
  params.set("startDate", startDate);
  params.set("endDate", endDate);
  params.set("scope", scope);
  if (classLevel) params.set("classLevel", classLevel);
  if (req.query.sortBy) params.set("sortBy", req.query.sortBy);
  if (req.query.studentId) params.set("studentId", req.query.studentId);

  const dataRes = await apiFetch(`/attendance/teacher-view?${params.toString()}`, req.token);
  const data = dataRes.status === "success" ? dataRes.data : {};
  if (dataRes.status !== "success") loadError = dataRes.message;

  res.render("attendance/teacher-view", {
    page: "attendance-view",
    user: req.user,
    rangeType,
    startDate,
    endDate,
    isSingleDay,
    scope,
    classLevel,
    classes: data.classes || [],
    dash: null,
    banner: null,
    weekly: [],
    monthly: null,
    classRows: [],
    insights: [],
    perClass: data.perClass || [],
    dailyTrend: data.dailyTrend || [],
    perStudent: data.perStudent || [],
    studentHistory: data.studentHistory || null,
    sortBy: req.query.sortBy || "",
    filters: {
      studentId: req.query.studentId || "",
    },
    weekStartValue: rangeType === "week" ? startDate : "",
    year: Number(req.query.year || now.getFullYear()),
    month: Number(req.query.month || now.getMonth() + 1),
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
