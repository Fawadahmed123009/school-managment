const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireAdminOrManager } = require("../../middlewares/authView");

// ── Admin/manager marks audit ───────────────────────────────────────────────
// Per-test marking oversight: score stats (avg/min/max, marks + percentages)
// and the marking timeline — when marks were first uploaded and when a teacher
// last changed them, and by whom. Server-rendered table; data comes from the
// admin-gated /tests/marks-audit API. Optional filters: search + teacher
// (marked-by dropdown; options come from the unfiltered-by-teacher fetch so
// the dropdown never collapses to just the selected marker).
router.get("/tests/marks-audit", requireAdminOrManager(), async (req, res) => {
  const { search, teacher } = req.query;
  const params = new URLSearchParams();
  if (search) params.set("search", String(search).slice(0, 120));

  const result = await apiFetch(`/tests/marks-audit?${params.toString()}`, req.token);
  let rows = result.status === "success" ? result.data : [];
  let loadError = result.status === "success" ? null : result.message;

  // Teacher options (id → name) from the same fetch — every marker visible
  // under the current search, across all their tests.
  const markers = new Map();
  rows.forEach((r) => (r.markers || []).forEach((m) => m.id && markers.set(m.id, m.name)));

  // Apply the teacher filter server-side via the API when one is chosen.
  const teacherId = teacher ? String(teacher).slice(0, 64) : "";
  if (teacherId) {
    params.set("teacher", teacherId);
    const filtered = await apiFetch(`/tests/marks-audit?${params.toString()}`, req.token);
    if (filtered.status === "success") {
      rows = filtered.data;
    } else {
      loadError = filtered.message;
      rows = [];
    }
    // A previously-selected teacher who no longer appears (e.g. after a new
    // search) must still render as the selected option.
    if (![...markers.keys()].some((id) => id.toLowerCase() === teacherId.toLowerCase())) {
      const hit = filtered.data && filtered.data[0];
      const name = hit ? (hit.markers || []).find((m) => String(m.id).toLowerCase() === teacherId.toLowerCase()) : null;
      markers.set(teacherId, name ? name.name : teacherId);
    }
  }

  res.render("tests/marks-audit", {
    page: "tests-marks-audit",
    user: req.user,
    rows,
    search: search ? String(search) : "",
    teacher: teacherId,
    markers: [...markers.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
