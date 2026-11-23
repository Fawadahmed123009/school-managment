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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES_FULL = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Weekday index for a "YYYY-MM-DD" attendance day key. The key is a LOCAL
// calendar date (see utils/localDateKey), so it must be parsed as local —
// `new Date("YYYY-MM-DD")` reads it as UTC and shifts the weekday. Same
// convention as the weekly chart labels and the student timeline.
const dowOf = (dateKey) => new Date(`${dateKey}T00:00:00`).getDay();

// ── Class-wise per-day breakdown ────────────────────────────────────────────
// The class table gets one column per marked day (Mon, Tue, Wed …) — the same
// day-by-day shape the weekly trend above already uses — instead of a single
// summed figure for the whole range. Only a single-day range yields no columns
// (so the daily view renders exactly as before); every multi-day range, weekly
// or monthly, now shows one column per day.
//
// A week's worth of columns is the line where two things change:
//   • the view route flags anything wider `classWiseScroll`, and the template
//     wraps it in a scroll container (sticky class-name column + sticky date
//     header) so ~30 month columns stay usable;
//   • the "Incomplete" label switches from weekday names to "Nov 3"-style
//     dates, because a bare weekday is ambiguous once a month repeats it.
// Neither writes data nor changes the payload — it is all derived from the
// `days` / `daily` / `shortDays` the service already returns.
const WEEK_COLUMNS = 7;

const MONTH_NAMES_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

function buildClassDayColumns(dash) {
  const days = dash && Array.isArray(dash.days) ? dash.days : [];
  if (days.length < 2) return [];
  return days.map((d) => ({
    date: d.date,
    // "Mon 16" — the day-of-month is just a convenience; the full date rides in
    // the column title and drives the sort key, so repeats never confuse it.
    label: `${DAY_NAMES_SHORT[dowOf(d.date)]} ${d.date.slice(8)}`,
  }));
}

// One cell per day column. `tone` reuses the weekly chart's colour language:
// nothing marked = grey, partially marked = amber, full roster = green.
function buildClassDayCells(row, columns) {
  const daily = row.daily || {};
  return columns.map((col) => {
    const rec = daily[col.date];
    const marked = rec ? rec.marked : 0;
    return {
      date: col.date,
      marked,
      enrolled: row.enrolled,
      present: rec ? rec.present : 0,
      absent: rec ? rec.absent : 0,
      late: rec ? rec.late : 0,
      rate: rec ? rec.rate : null,
      tone: marked === 0 ? "none" : marked < row.enrolled ? "partial" : "full",
      // Consumed by the table's existing generic sorter (data-day-<date>);
      // an unmarked day gives "" so it sinks to the bottom of the column.
      sortValue: rec && rec.rate !== null ? rec.rate : "",
    };
  });
}

// Pill text + tooltip for a class the range flagged incomplete.
// Within a week it reads "Incomplete: Wednesday, Thursday"; wider ranges list
// the dates instead — "Incomplete: Nov 3, Nov 11" — since a weekday alone is
// ambiguous once a month repeats it. Either way the FULL list of gaps is shown:
// the monthly breakdown exists precisely so the attendance-taker can see every
// day still to fill in, so there is no "+N more" truncation. When there is no
// day detail to name (a single-day range, or a class whose gaps were never
// computed) both keep their original lowercase wording, so the daily view
// renders exactly as before.
function buildIncomplete(dash, row) {
  const generic = {
    label: "incomplete",
    title: "Some students/days are unmarked in this range",
  };
  const days = dash && Array.isArray(dash.days) ? dash.days : [];
  const dates = days.length > 1 ? (row.shortDays || []) : [];
  if (dates.length === 0) return generic;

  // Tooltip keeps the per-day shortfall for every named day, complete list.
  const daily = row.daily || {};
  const title = dates
    .map((d) => `${d}: ${daily[d] ? daily[d].marked : 0}/${row.enrolled} marked`)
    .join(" · ");

  // Ranges wider than a week: month + day-of-month, unambiguous across a month.
  if (days.length > WEEK_COLUMNS) {
    const pretty = dates.map(
      (d) => `${MONTH_NAMES_SHORT[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`
    );
    return { label: `Incomplete: ${pretty.join(", ")}`, title };
  }

  // Within a week the weekday is unique, so the plain name reads best. A range
  // of a few marked days can still span past a week and repeat one; then the
  // date rides along to disambiguate ("Wed 11-18"), exactly as before.
  const names = dates.map((d) => DAY_NAMES_FULL[dowOf(d)]);
  const ambiguous = new Set(names).size !== names.length;
  const titled = dates.map((d, i) =>
    ambiguous ? `${names[i].slice(0, 3)} ${d.slice(5)}` : names[i]
  );
  return { label: `Incomplete: ${titled.join(", ")}`, title };
}

const fmtPct = (v) => (v === null || v === undefined ? "—" : v + "%");

// ── Admin/Manager attendance dashboard (unified filter interface) ───────────

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

  let loadError = null;

  // ══════════════════════════════════════════════════════════════════
  // INSTITUTE / CLASS SCOPE → dashboard aggregates
  // ══════════════════════════════════════════════════════════════════
  if (scope === "institute" || scope === "class") {
    const classParam = scope === "class" && classLevel ? `&classLevel=${classLevel}` : "";

    // Monthly Report card always covers the calendar month the range ends in
    // (equals the selected month when rangeType=month).
    const eD = parseLocalDate(endDate);
    const monthYear = eD.getFullYear();
    const monthNum = eD.getMonth() + 1;
    const monthFirst = toISODate(new Date(monthYear, monthNum - 1, 1));
    const monthLast = toISODate(new Date(monthYear, monthNum, 0));
    const monthLabel = `${MONTH_NAMES[monthNum - 1]} ${monthYear}`;

    const [dashRes, monthRes] = await Promise.all([
      apiFetch(`/attendance/dashboard?startDate=${startDate}&endDate=${endDate}${classParam}`, req.token),
      apiFetch(`/attendance/dashboard?startDate=${monthFirst}&endDate=${monthLast}${classParam}&breakdown=0`, req.token),
    ]);

    let dash = null;
    let monthly = null;

    if (dashRes.status === "success") dash = dashRes.data;
    else loadError = dashRes.message;

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

    // ── Incomplete-marking banner ──
    // Single day (any scope): marked head-count vs enrolled.
    // Multi-day institute-wide: marked records vs enrolled × days-with-attendance
    // (days with zero institute records are treated as non-school days).
    // Class-scoped multi-day is covered by the class-wise table flagging instead.
    let banner = null;
    if (dash && dash.enrolled > 0) {
      if (isSingleDay) {
        if (dash.summary.marked < dash.enrolled) {
          banner = { marked: dash.summary.marked, expected: dash.enrolled, singleDay: true };
        }
      } else if (scope === "institute" && dash.days.length > 0) {
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
        // partial = day was marked but not everyone enrolled got a record
        partial: !!(d && dash && d.marked < dash.enrolled),
        unmarked: !d,
      });
    }

    const classRows = dash ? dash.classes : [];

    // ── Class-wise table model ──
    // Range totals stay exactly as they were; the per-day cells and the
    // specific missing-day label are added on top, so the teacher-facing view
    // (which renders the same payload without these fields) is untouched.
    const classDayColumns = buildClassDayColumns(dash);
    // Wider than a normal week → too many day cells for the fixed table, so the
    // template wraps the grid in a scroll container (sticky class column + date
    // header). Weekly (≤7) keeps the plain, non-scrolling table exactly as-is.
    const classWiseScroll = classDayColumns.length > WEEK_COLUMNS;
    classRows.forEach((c) => {
      c.dayCells = buildClassDayCells(c, classDayColumns);
      const incomplete = buildIncomplete(dash, c);
      c.incompleteLabel = incomplete.label;
      c.incompleteTitle = incomplete.title;
    });

    // ── Insight tiles (v1: one computed sentence each, linking to the
    // relevant filtered view of this page — deep views come later) ──
    const insights = [];
    if (dash) {
      const s = dash.summary;

      // Absence analysis: worst day in range by absent count
      let worstDay = null;
      dash.days.forEach((d) => {
        if (!worstDay || d.absent > worstDay.absent) worstDay = d;
      });

      // Class-wise highlights (institute scope only — classRows empty for class scope)
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
        href: "/attendance/rollup?rangeType=today&scope=institute",
      });

      insights.push({
        icon: "month",
        tone: "accent-purple",
        title: "Monthly Trends",
        desc: monthly && monthly.avgRate !== null
          ? `${monthly.label}: avg ${fmtPct(monthly.avgRate)} across ${monthly.markedDays} marked day${monthly.markedDays === 1 ? "" : "s"}`
          : `No attendance recorded in ${monthLabel} yet`,
        href: `/attendance/rollup?rangeType=month&year=${monthYear}&month=${monthNum}&scope=institute`,
      });

      insights.push({
        icon: "absent",
        tone: "accent-red",
        title: "Absence Analysis",
        desc: s.marked > 0
          ? `${s.absent} absences (${Math.round((s.absent / s.marked) * 100)}% of marked)` +
            (worstDay && worstDay.absent > 0 ? ` · worst day ${worstDay.date} with ${worstDay.absent}` : "")
          : "No attendance marked for this range",
        href: `/attendance/rollup?${rangeParams}&scope=student`,
      });

      insights.push({
        icon: "late",
        tone: "accent-gold",
        title: "Late Arrivals",
        desc: s.marked > 0
          ? `${s.late} late arrival${s.late === 1 ? "" : "s"} (${Math.round((s.late / s.marked) * 100)}% of marked records)`
          : "No attendance marked for this range",
        href: `/attendance/rollup?${rangeParams}&scope=student`,
      });

      insights.push({
        icon: "class",
        tone: "accent-green",
        title: "Class-wise Insights",
        desc: scope === "class"
          ? "Pick a class above to drill into its own attendance detail"
          : (classRows.length
            ? `${incompleteCount} of ${classRows.length} classes incomplete` +
              (bestClass && worstClass ? ` · top ${bestClass.name} ${fmtPct(bestClass.rate)}, low ${worstClass.name} ${fmtPct(worstClass.rate)}` : "")
            : "No class data in this range"),
        href: `/attendance/rollup?${rangeParams}&scope=class`,
      });
    }

    return res.render("attendance/rollup", {
      page: "attendance-rollup",
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
      classDayColumns,
      classWiseScroll,
      insights,
      // Student-scope vars kept for the shared template branches
      dailyRollup: [],
      rollup: {},
      studentSearch: { students: [], history: null, summary: null },
      filters: { rollNumber: "", name: "", studentId: "", sortBy: "" },
      weekStartValue: rangeType === "week" ? startDate : "",
      year: Number(req.query.year || now.getFullYear()),
      month: Number(req.query.month || now.getMonth() + 1),
      loadError,
      schoolName: res.locals.schoolName,
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // STUDENT SCOPE — unchanged list + history flow
  // ══════════════════════════════════════════════════════════════════
  const params = new URLSearchParams();
  params.set("startDate", startDate);
  params.set("endDate", endDate);
  if (classLevel) params.set("classLevel", classLevel);
  if (req.query.rollNumber) params.set("rollNumber", req.query.rollNumber);
  if (req.query.name) params.set("name", req.query.name);
  if (req.query.studentId) params.set("studentId", req.query.studentId);
  if (req.query.sortBy) params.set("sortBy", req.query.sortBy);

  const dataRes = await apiFetch(`/attendance/student-history?${params.toString()}`, req.token);
  let studentSearch = { students: [], history: null, summary: null };
  if (dataRes.status === "success") studentSearch = dataRes.data;
  else loadError = dataRes.message;

  return res.render("attendance/rollup", {
    page: "attendance-rollup",
    user: req.user,
    rangeType,
    startDate,
    endDate,
    isSingleDay,
    scope,
    classLevel,
    classes,
    dash: null,
    banner: null,
    weekly: [],
    monthly: null,
    classRows: [],
    classDayColumns: [],
    classWiseScroll: false,
    insights: [],
    dailyRollup: [],
    rollup: {},
    studentSearch,
    filters: {
      rollNumber: req.query.rollNumber || "",
      name: req.query.name || "",
      studentId: req.query.studentId || "",
      sortBy: req.query.sortBy || "",
    },
    weekStartValue: rangeType === "week" ? startDate : "",
    year: Number(req.query.year || now.getFullYear()),
    month: Number(req.query.month || now.getMonth() + 1),
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
