const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireAdminOrManager } = require("../../middlewares/authView");

// ── Admin/manager marks audit ───────────────────────────────────────────────
// Per-test marking oversight: score stats (avg/min/max, marks + percentages)
// and the marking timeline — when marks were first uploaded and when a teacher
// last changed them, and by whom. Server-rendered table; data comes from the
// admin-gated /tests/marks-audit API. Optional filters: search, teacher
// (marked-by dropdown), marking status (marked / unmarked) and the session →
// phase → week category cascade — all applied server-side via the API.
// Dropdown options come from an unfiltered-by-category fetch (limit=all) so
// a select never collapses to just the active choice. Results are paginated
// (25 per page) and ordered by urgency: critical, overdue, outstanding,
// fully marked last.
const PAGE_LIMIT = 25;
const NONE_KEY = "none";
const STATUS_VALUES = ["marked", "unmarked"];

// Page size: the default above, overridable via ?limit= (1–100).
const pageLimit = (value) => Math.min(100, Math.max(1, parseInt(value, 10) || PAGE_LIMIT));

// "none" is a real filter value (uncategorised tests), not "no choice".
const activeCat = (value) => {
  const v = value ? String(value).slice(0, 64) : "";
  return v ? { v, keep: v !== NONE_KEY } : { v: "", keep: false };
};

// Marking-status filter: only the two known values narrow the ledger.
const activeStatus = (value) => {
  const v = String(value || "").trim().toLowerCase().slice(0, 16);
  return STATUS_VALUES.includes(v) ? v : "";
};

router.get("/tests/marks-audit", requireAdminOrManager(), async (req, res) => {
  const {
    search,
    teacher,
    status,
    session: sessionQ,
    phase: phaseQ,
    week: weekQ,
    page: pageQ,
  } = req.query;
  const params = new URLSearchParams();
  if (search) params.set("search", String(search).slice(0, 120));

  // First fetch: everything (search only) — page rows AND every category /
  // marker option are derived from this full unpaginated row set.
  params.set("limit", "all");
  const result = await apiFetch(`/tests/marks-audit?${params.toString()}`, req.token);
  let envelope = result.status === "success" ? result.data : { rows: [], pagination: null };
  let rows = envelope.rows || [];
  let total = envelope.pagination ? envelope.pagination.total : rows.length;
  let loadError = result.status === "success" ? null : result.message;

  // Teacher options (id → name) and the session/phase/week option lists are
  // built from the FULL row set (categories are just labels here, no
  // filtering yet) so every option stays visible under any active filter.
  const markers = new Map();
  const sessions = new Map();
  const phases = new Map();
  const weeks = new Map();
  const catOpts = (map, id, name, fallback) => {
    if (!id) return;
    if (!map.has(id)) map.set(id, name || fallback);
  };
  rows.forEach((r) => {
    (r.markers || []).forEach((m) => m.id && markers.set(m.id, m.name));
    catOpts(sessions, r.session, r.sessionName, "Standalone");
    catOpts(phases, r.phase, r.phaseName, "No phase");
    catOpts(weeks, r.week, r.weekName, "No week");
  });
  // Uncategorised rows must be selectable too — the API keeps them under the
  // magic "none" value.
  if (rows.some((r) => !r.session)) sessions.set(NONE_KEY, "Standalone");
  if (rows.some((r) => !r.phase)) phases.set(NONE_KEY, "No phase");
  if (rows.some((r) => !r.week)) weeks.set(NONE_KEY, "No week");

  // Apply the chosen filters server-side via the API (categories + teacher
  // together in one fetch) and read the paginated slice from the envelope.
  // Runs even with no filter when a page beyond 1 is requested, so the rows
  // always come from the requested slice while options stay global.
  const catSel = {
    session: activeCat(sessionQ),
    phase: activeCat(phaseQ),
    week: activeCat(weekQ),
  };
  const teacherId = teacher ? String(teacher).slice(0, 64) : "";
  const statusSel = activeStatus(status);
  const pg = Math.max(1, parseInt(pageQ, 10) || 1);
  const lm = pageLimit(req.query.limit);
  if (
    teacherId ||
    statusSel ||
    catSel.session.keep ||
    catSel.phase.keep ||
    catSel.week.keep ||
    pg > 1 ||
    lm !== PAGE_LIMIT
  ) {
    params.delete("limit");
    if (teacherId) params.set("teacher", teacherId);
    if (statusSel) params.set("status", statusSel);
    if (catSel.session.v) params.set("session", catSel.session.v);
    if (catSel.phase.v) params.set("phase", catSel.phase.v);
    if (catSel.week.v) params.set("week", catSel.week.v);
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
    // A previously-selected teacher or category that no longer appears (e.g.
    // after a new search) must still render as the selected option.
    const keepSelected = (map, selected, allRows, fallback) => {
      if (!selected.keep || [...map.keys()].some((id) => id.toLowerCase() === selected.v.toLowerCase())) return;
      const hit = (allRows || [])[0];
      const match = hit && (hit.markers || []).find((m) => String(m.id).toLowerCase() === selected.v.toLowerCase());
      map.set(selected.v, match ? match.name : fallback);
    };
    keepSelected(markers, { keep: !!teacherId, v: teacherId }, rows, teacherId);
    keepSelected(sessions, catSel.session, rows, "Standalone");
    keepSelected(phases, catSel.phase, rows, "No phase");
    keepSelected(weeks, catSel.week, rows, "No week");
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
    phase: catSel.phase.v,
    week: catSel.week.v,
    sessions: [...sessions.entries()].map(([id, name]) => ({ id, name })),
    phases: [...phases.entries()].map(([id, name]) => ({ id, name })),
    weeks: [...weeks.entries()].map(([id, name]) => ({ id, name })),
    markers: [...markers.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
