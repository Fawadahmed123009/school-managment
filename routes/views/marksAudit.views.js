const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireAdminOrManager } = require("../../middlewares/authView");

// ── Admin/manager marks audit ───────────────────────────────────────────────
// Per-test marking oversight: score stats (avg/min/max, marks + percentages)
// and the marking timeline — when marks were first uploaded and when a teacher
// last changed them, and by whom. Server-rendered table; data comes from the
// admin-gated /tests/marks-audit API. Optional filters: search, teacher
// (marked-by dropdown), marking status (marked / unmarked) and the
// session → grade → class cascade — all applied server-side via the API.
// The cascade is CASCADING for real: the grade options are the grades that
// actually occur in the chosen session's tests, and the class options are the
// classes in the chosen session + grade, so an impossible combination is never
// offered. Options are derived from an unfiltered-by-category fetch
// (limit=all) — a select only ever lists choices that exist in the data.
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
// Fallback labels for the "none" sentinel at each cascade level.
const NONE_LABELS = { session: "Standalone", grade: "No grade", class: "No class" };

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

// A test targets a LIST of classes, so grade / class selection is an ANY match
// on the row keys; "none" keeps the rows whose list is empty.
const rowInSession = (r, sel) =>
  !sel.keep ||
  (sel.v === NONE_KEY ? !r.session : String(r.session || "").toLowerCase() === sel.v.toLowerCase());
const rowInGrade = (r, sel) =>
  !sel.keep ||
  (sel.v === NONE_KEY
    ? !(r.gradeLevels || []).length
    : (r.gradeLevels || []).some((g) => String(g).toLowerCase() === sel.v.toLowerCase()));
const rowInClass = (r, sel) =>
  !sel.keep ||
  (sel.v === NONE_KEY
    ? !(r.classLevels || []).length
    : (r.classLevels || []).some((c) => String(c.id).toLowerCase() === sel.v.toLowerCase()));

// Class option label mirrors the marking picker: "5 — Class A (Pre-Medical)".
const classLabel = (c) =>
  `${c.gradeLevel ? `${c.gradeLevel} — ` : ""}${c.name || c.id}${c.group ? ` (${c.group})` : ""}`;

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
    classLevel: classQ,
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
    class: activeCat(classQ),
  };

  // Teacher options (id → name) come from the FULL row set, so the dropdown
  // never collapses to just the active choice.
  const markers = new Map();
  allRows.forEach((r) => (r.markers || []).forEach((m) => m.id && markers.set(m.id, m.name)));

  // ── cascade options, each level narrowed only by the levels above it ───────
  const sessions = new Map();
  allRows.forEach((r) => {
    if (r.session) sessions.set(String(r.session), r.sessionName || NONE_LABELS.session);
  });
  if (allRows.some((r) => !r.session)) sessions.set(NONE_KEY, NONE_LABELS.session);
  // A value chosen upstream that the data no longer offers (manual URL edit, or
  // a category removed since) still has to render as the selected option, or
  // the ledger would be filtered by a choice the select pretends isn't there.
  if (catSel.session.keep && !hasKey(sessions, catSel.session.v)) {
    const hit = allRows.find((r) => String(r.session || "").toLowerCase() === catSel.session.v.toLowerCase());
    sessions.set(catSel.session.v, (hit && hit.sessionName) || catSel.session.v);
  }

  const inSessionRows = allRows.filter((r) => rowInSession(r, catSel.session));
  const grades = new Map();
  inSessionRows.forEach((r) =>
    (r.gradeLevels || []).forEach((g) => g && grades.set(String(g), `Grade ${g}`))
  );
  if (inSessionRows.some((r) => !(r.gradeLevels || []).length)) {
    grades.set(NONE_KEY, NONE_LABELS.grade);
  }
  if (catSel.grade.keep && !hasKey(grades, catSel.grade.v)) {
    grades.set(catSel.grade.v, `Grade ${catSel.grade.v}`);
  }

  // Class options come from the classes the scoped rows actually target IN the
  // picked grade — a test spanning grades 5 and 9 is listed under grade 9 with
  // its grade-9 class only, so the class select never shows a class that the
  // grade select above it just excluded.
  const classPoolOf = (r) => {
    const list = r.classLevels || [];
    if (!catSel.grade.keep) return list;
    return catSel.grade.v === NONE_KEY
      ? list.filter((c) => !c.gradeLevel)
      : list.filter((c) => String(c.gradeLevel || "").toLowerCase() === catSel.grade.v.toLowerCase());
  };
  const scopeRows = inSessionRows.filter((r) => rowInGrade(r, catSel.grade));
  const classes = new Map();
  scopeRows.forEach((r) =>
    classPoolOf(r).forEach((c) => {
      if (c.id) classes.set(String(c.id), { ...c, label: classLabel(c) });
    })
  );
  if (scopeRows.some((r) => classPoolOf(r).length === 0)) {
    classes.set(NONE_KEY, { id: NONE_KEY, gradeLevel: "", name: NONE_LABELS.class, label: NONE_LABELS.class });
  }
  // A class picked from another level's snapshot (or removed since) still needs
  // its real label — fall back to the global index, then to the raw id.
  if (catSel.class.keep && !hasKey(classes, catSel.class.v)) {
    const known = allRows
      .flatMap((r) => r.classLevels || [])
      .find((c) => String(c.id).toLowerCase() === catSel.class.v.toLowerCase());
    classes.set(catSel.class.v, known ? { ...known, label: classLabel(known) } : { id: catSel.class.v, label: catSel.class.v });
  }

  const sortedGrades = [...grades.entries()].sort((a, b) => gradeRank(a[0]) - gradeRank(b[0]));
  const sortedClasses = [...classes.values()].sort(
    (a, b) =>
      gradeRank(a.gradeLevel) - gradeRank(b.gradeLevel) ||
      String(a.label).localeCompare(String(b.label))
  );

  // Apply the chosen filters server-side via the API (categories + teacher
  // together in one fetch) and read the paginated slice from the envelope.
  // Runs even with no filter when a page beyond 1 is requested, so the rows
  // always come from the requested slice while options stay global.
  const teacherId = teacher ? String(teacher).slice(0, 64) : "";
  const statusSel = activeStatus(status);
  const pg = Math.max(1, parseInt(pageQ, 10) || 1);
  const lm = pageLimit(req.query.limit);
  if (
    teacherId ||
    statusSel ||
    catSel.session.keep ||
    catSel.grade.keep ||
    catSel.class.keep ||
    pg > 1 ||
    lm !== PAGE_LIMIT
  ) {
    params.delete("limit");
    if (teacherId) params.set("teacher", teacherId);
    if (statusSel) params.set("status", statusSel);
    if (catSel.session.v) params.set("session", catSel.session.v);
    if (catSel.grade.v) params.set("grade", catSel.grade.v);
    if (catSel.class.v) params.set("classLevel", catSel.class.v);
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
    // A previously-selected teacher that no longer appears (e.g. after a new
    // search) must still render as the selected option.
    if (teacherId && ![...markers.keys()].some((id) => id.toLowerCase() === teacherId.toLowerCase())) {
      const hit = (rows || [])[0];
      const match = hit && (hit.markers || []).find((m) => String(m.id).toLowerCase() === teacherId.toLowerCase());
      markers.set(teacherId, match ? match.name : teacherId);
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
    teacher: teacherId,
    status: statusSel,
    session: catSel.session.v,
    grade: catSel.grade.v,
    classLevel: catSel.class.v,
    sessions: [...sessions.entries()].map(([id, name]) => ({ id, name })),
    grades: sortedGrades.map(([id, name]) => ({ id, name })),
    classes: sortedClasses.map((c) => ({ id: c.id, name: c.label })),
    markers: [...markers.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
