const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireAdminOrManager } = require("../../middlewares/authView");

// ── Admin/manager marks audit ───────────────────────────────────────────────
// Per-test marking oversight: score stats (avg/min/max, marks + percentages)
// and the marking timeline — when marks were first uploaded and when a teacher
// last changed them, and by whom. Server-rendered table; data comes from the
// admin-gated /tests/marks-audit API. Optional filters: search, a teacher
// typeahead (marked-by, searched by name), marking status (marked / unmarked)
// and the session → grade → phase → week → subject cascade — all applied
// server-side via the API.
// The cascade is CASCADING for real: every level lists only what the choices
// above it actually contain (grades of the picked session, phases that session
// + grade holds, the weeks of session + grade + phase, and subjects with a test
// in session + grade + phase + week), so an impossible combination is never
// offered. Options come from one unfiltered-by-category fetch (limit=all) over
// the whole row set.
// Results are paginated (25 per page) and ordered by urgency: critical,
// overdue, outstanding, fully marked last.
const PAGE_LIMIT = 25;
const NONE_KEY = "none";
const STATUS_VALUES = ["marked", "unmarked"];
// PG first, then 1–12 numerically (gradeLevel is stored as a string).
const GRADE_ORDER = ["PG", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const gradeRank = (g) => {
  const i = GRADE_ORDER.indexOf(String(g));
  return i === -1 ? GRADE_ORDER.length : i;
};
// A phase with no `order` recorded sinks below the ordered ones of its session.
const PHASE_ORDER_LAST = 1e9;
// Fallback labels for the "none" sentinel at each cascade level.
const NONE_LABELS = {
  session: "Standalone",
  grade: "No grade",
  phase: "No phase",
  week: "No week",
};

// Page size: the default above, overridable via ?limit= (1–100).
const pageLimit = (value) => Math.min(100, Math.max(1, parseInt(value, 10) || PAGE_LIMIT));

// "none" is a real filter value (rows missing that level), not "no choice".
const activeCat = (value) => {
  const v = value ? String(value).slice(0, 64) : "";
  return v ? { v, keep: v !== NONE_KEY } : { v: "", keep: false };
};

// Marking-status filter: only the two known values narrow the ledger.
const activeStatus = (value) => {
  const v = String(value || "").trim().toLowerCase().slice(0, 16);
  return STATUS_VALUES.includes(v) ? v : "";
};

// Level predicates — one per cascade level, applied to the FULL row set when
// building the options below it. A test targets a LIST of classes, so the grade
// level is an ANY match; session / phase / week / subject are single-valued.
const rowInSession = (r, sel) =>
  !sel.v ||
  (sel.v === NONE_KEY ? !r.session : String(r.session || "").toLowerCase() === sel.v.toLowerCase());
const rowInGrade = (r, sel) =>
  !sel.v ||
  (sel.v === NONE_KEY
    ? !(r.gradeLevels || []).length
    : (r.gradeLevels || []).some((g) => String(g).toLowerCase() === sel.v.toLowerCase()));
const rowInPhase = (r, sel) =>
  !sel.v ||
  (sel.v === NONE_KEY ? !r.phase : String(r.phase || "").toLowerCase() === sel.v.toLowerCase());
const rowInWeek = (r, sel) =>
  !sel.v ||
  (sel.v === NONE_KEY ? !r.week : String(r.week || "").toLowerCase() === sel.v.toLowerCase());
const rowInSubject = (r, sel) =>
  !sel.v || String(r.subjectId || "").toLowerCase() === sel.v.toLowerCase();

// Option maps key on the ids as the API reported them; a selection coming from
// the URL may differ in case, so "is it already offered?" is matched loosely to
// keep the fallbacks from appending a duplicate option.
const hasKey = (map, value) =>
  [...map.keys()].some((k) => String(k).toLowerCase() === String(value).toLowerCase());

router.get("/tests/marks-audit", requireAdminOrManager(), async (req, res) => {
  const {
    search,
    teacher,
    status,
    session: sessionQ,
    grade: gradeQ,
    phase: phaseQ,
    week: weekQ,
    subject: subjectQ,
    page: pageQ,
  } = req.query;
  const params = new URLSearchParams();
  if (search) params.set("search", String(search).slice(0, 120));

  // First fetch: everything (search only) — page rows AND every cascade /
  // marker option are derived from this full unpaginated row set.
  params.set("limit", "all");
  const result = await apiFetch(`/tests/marks-audit?${params.toString()}`, req.token);
  let envelope = result.status === "success" ? result.data : { rows: [], pagination: null };
  let rows = envelope.rows || [];
  let total = envelope.pagination ? envelope.pagination.total : rows.length;
  let loadError = result.status === "success" ? null : result.message;
  // Snapshot of the full set: the cascade option lists are always rebuilt from
  // it, so narrowing one select never loses the options of the others.
  const allRows = rows;

  // Active selections, resolved before any option list is built.
  const catSel = {
    session: activeCat(sessionQ),
    grade: activeCat(gradeQ),
    phase: activeCat(phaseQ),
    week: activeCat(weekQ),
    subject: activeCat(subjectQ),
  };

  // Teacher options (id → name) come from the FULL row set, so the typeahead
  // never collapses to just the active choice.
  const markers = new Map();
  allRows.forEach((r) => (r.markers || []).forEach((m) => m.id && markers.set(m.id, m.name)));

  // ── level 1: sessions — the top of the cascade, never narrowed ────────────
  const sessions = new Map();
  allRows.forEach((r) => {
    if (r.session) sessions.set(String(r.session), r.sessionName || NONE_LABELS.session);
  });
  if (allRows.some((r) => !r.session)) sessions.set(NONE_KEY, NONE_LABELS.session);
  // A value the data no longer offers (manual URL edit, or a category removed
  // since) still has to render as the selected option, or the ledger would be
  // filtered by a choice the select pretends isn't there.
  if (catSel.session.keep && !hasKey(sessions, catSel.session.v)) {
    const hit = allRows.find((r) => String(r.session || "").toLowerCase() === catSel.session.v.toLowerCase());
    sessions.set(catSel.session.v, (hit && hit.sessionName) || catSel.session.v);
  }

  // ── level 2: grades of the chosen session ─────────────────────────────────
  const sessionRows = allRows.filter((r) => rowInSession(r, catSel.session));
  const grades = new Map();
  sessionRows.forEach((r) =>
    (r.gradeLevels || []).forEach((g) => g && grades.set(String(g), `Grade ${g}`))
  );
  if (sessionRows.some((r) => !(r.gradeLevels || []).length)) {
    grades.set(NONE_KEY, NONE_LABELS.grade);
  }
  if (catSel.grade.keep && !hasKey(grades, catSel.grade.v)) {
    grades.set(catSel.grade.v, `Grade ${catSel.grade.v}`);
  }
  const sortedGrades = [...grades.entries()].sort((a, b) => gradeRank(a[0]) - gradeRank(b[0]));

  // ── level 3: phases of the chosen session + grade ─────────────────────────
  // Phases belong to a session, so the same phase name can exist twice under
  // two sessions: with no session picked the label carries its session, which
  // also keeps the two apart. Ordering follows the session's own phase order.
  const gradeRows = sessionRows.filter((r) => rowInGrade(r, catSel.grade));
  const phases = new Map();
  gradeRows.forEach((r) => {
    if (!r.phase) return;
    const key = String(r.phase);
    if (phases.has(key)) return;
    const name = r.phaseName || "Phase";
    phases.set(key, {
      id: key,
      name: catSel.session.v ? name : `${r.sessionName || NONE_LABELS.session} · ${name}`,
      sessionName: r.sessionName || "",
      order: Number.isFinite(r.phaseOrder) ? r.phaseOrder : PHASE_ORDER_LAST,
    });
  });
  if (gradeRows.some((r) => !r.phase)) {
    phases.set(NONE_KEY, { id: NONE_KEY, name: NONE_LABELS.phase, sessionName: "", order: PHASE_ORDER_LAST });
  }
  if (catSel.phase.keep && !hasKey(phases, catSel.phase.v)) {
    const known = allRows.find((r) => String(r.phase || "").toLowerCase() === catSel.phase.v.toLowerCase());
    phases.set(catSel.phase.v, {
      id: catSel.phase.v,
      name: (known && known.phaseName) || catSel.phase.v,
      sessionName: (known && known.sessionName) || "",
      order: known && Number.isFinite(known.phaseOrder) ? known.phaseOrder : PHASE_ORDER_LAST,
    });
  }
  const sortedPhases = [...phases.values()].sort(
    (a, b) =>
      String(a.sessionName).localeCompare(String(b.sessionName)) ||
      a.order - b.order ||
      String(a.name).localeCompare(String(b.name))
  );

  // ── level 4: weeks of the chosen session + grade + phase ──────────────────
  // A Week belongs to one phase, so "Week 1" can exist twice in the same
  // session — once per phase. With no phase picked the label carries its phase
  // (which also keeps the two apart) and the list groups by phase, running
  // chronologically inside each group via the week's own startDate.
  const phaseRows = gradeRows.filter((r) => rowInPhase(r, catSel.phase));
  // A week with no startDate recorded sinks below the dated ones of its phase.
  const WEEK_START_LAST = Number.MAX_SAFE_INTEGER;
  const weekEntry = (r) => ({
    id: String(r.week),
    name: catSel.phase.v
      ? r.weekName || "Week"
      : `${r.phaseName || NONE_LABELS.phase} · ${r.weekName || "Week"}`,
    phaseName: r.phaseName || "",
    start: r.weekStart ? new Date(r.weekStart).getTime() : WEEK_START_LAST,
  });
  const weeks = new Map();
  phaseRows.forEach((r) => {
    if (!r.week) return;
    const key = String(r.week);
    if (!weeks.has(key)) weeks.set(key, weekEntry(r));
  });
  if (phaseRows.some((r) => !r.week)) {
    weeks.set(NONE_KEY, { id: NONE_KEY, name: NONE_LABELS.week, phaseName: "", start: WEEK_START_LAST });
  }
  if (catSel.week.keep && !hasKey(weeks, catSel.week.v)) {
    const known = allRows.find((r) => String(r.week || "").toLowerCase() === catSel.week.v.toLowerCase());
    weeks.set(
      catSel.week.v,
      known
        ? weekEntry(known)
        : { id: catSel.week.v, name: catSel.week.v, phaseName: "", start: WEEK_START_LAST }
    );
  }
  const sortedWeeks = [...weeks.values()].sort(
    (a, b) =>
      String(a.phaseName).localeCompare(String(b.phaseName)) ||
      a.start - b.start ||
      String(a.name).localeCompare(String(b.name), undefined, { numeric: true })
  );

  // ── level 5: subjects with a test in session + grade + phase + week ───────
  const weekRows = phaseRows.filter((r) => rowInWeek(r, catSel.week));
  const subjects = new Map();
  weekRows.forEach((r) => {
    if (r.subjectId) subjects.set(String(r.subjectId), r.subject || String(r.subjectId));
  });
  if (catSel.subject.keep && !hasKey(subjects, catSel.subject.v)) {
    const known = allRows.find((r) => String(r.subjectId || "").toLowerCase() === catSel.subject.v.toLowerCase());
    subjects.set(catSel.subject.v, (known && known.subject) || catSel.subject.v);
  }
  const sortedSubjects = [...subjects.entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))
    .map(([id, name]) => ({ id, name }));

  // Apply the chosen filters server-side via the API (cascade + teacher +
  // status in one fetch) and read the paginated slice from the envelope.
  // Runs whenever ANY level is chosen — "none" is a real choice too — or when
  // a page beyond 1 / a non-default page size is requested, so the rows always
  // come from the requested slice while the options stay cascade-derived.
  const teacherQ = teacher ? String(teacher).slice(0, 120) : "";
  const statusSel = activeStatus(status);
  const pg = Math.max(1, parseInt(pageQ, 10) || 1);
  const lm = pageLimit(req.query.limit);
  if (
    teacherQ ||
    statusSel ||
    catSel.session.v ||
    catSel.grade.v ||
    catSel.phase.v ||
    catSel.week.v ||
    catSel.subject.v ||
    pg > 1 ||
    lm !== PAGE_LIMIT
  ) {
    params.delete("limit");
    if (teacherQ) params.set("teacher", teacherQ);
    if (statusSel) params.set("status", statusSel);
    if (catSel.session.v) params.set("session", catSel.session.v);
    if (catSel.grade.v) params.set("grade", catSel.grade.v);
    if (catSel.phase.v) params.set("phase", catSel.phase.v);
    if (catSel.week.v) params.set("week", catSel.week.v);
    if (catSel.subject.v) params.set("subject", catSel.subject.v);
    params.set("page", String(pg));
    params.set("limit", String(lm));
    const filtered = await apiFetch(`/tests/marks-audit?${params.toString()}`, req.token);
    if (filtered.status === "success") {
      envelope = filtered.data || { rows: [], pagination: null };
      rows = envelope.rows || [];
      total = envelope.pagination ? envelope.pagination.total : rows.length;
    } else {
      loadError = filtered.message;
      rows = [];
      total = 0;
    }
    // A teacher that no longer appears (e.g. after a new search) must still be
    // offered by the typeahead, or the ledger would be filtered by an unknown
    // name with nothing to show it.
    if (teacherQ && ![...markers.values()].some((n) => (n || "").toLowerCase().includes(teacherQ.toLowerCase()))) {
      markers.set(teacherQ, teacherQ);
    }
  }

  const pages = Math.max(1, Math.ceil(total / lm));
  const pagination = {
    total,
    page: Math.min(pg, pages),
    limit: lm,
    pages,
    hasPrev: pg > 1,
    hasNext: pg < pages,
  };

  res.render("tests/marks-audit", {
    page: "tests-marks-audit",
    user: req.user,
    rows,
    pagination,
    search: search ? String(search) : "",
    teacher: teacherQ,
    status: statusSel,
    session: catSel.session.v,
    grade: catSel.grade.v,
    phase: catSel.phase.v,
    week: catSel.week.v,
    subject: catSel.subject.v,
    sessions: [...sessions.entries()].map(([id, name]) => ({ id, name })),
    grades: sortedGrades.map(([id, name]) => ({ id, name })),
    phases: sortedPhases.map((p) => ({ id: p.id, name: p.name })),
    weeks: sortedWeeks.map((w) => ({ id: w.id, name: w.name })),
    subjects: sortedSubjects,
    markers: [...markers.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
