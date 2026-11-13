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
    (c) => c._id.toString() === req.params.classLevelId.toString()
  );

  res.render("attendance/mark", {
    page: "attendance",
    user: req.user,
    ok: req.query.ok === "1",
    // The POST failure path redirects with ?error= — without passing it
    // through, the template's error banner never rendered and failed saves
    // silently vanished.
    error: req.query.error || null,
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
  const back = `/attendance/mark/${req.params.classLevelId}?date=${date}`;
  // records arrives as a JSON string from a hidden input, built client-side.
  // A malformed/missing payload must bounce back with a message — an
  // unguarded parse threw a raw JSON 500 page at the teacher instead.
  let parsed;
  try {
    parsed = JSON.parse(records);
  } catch (err) {
    return res.redirect(`${back}&error=${encodeURIComponent("Could not read the attendance entries — reload the page and try again.")}`);
  }

  const result = await apiFetch("/attendance", req.token, {
    method: "POST",
    body: JSON.stringify({ classLevel: req.params.classLevelId, date, records: parsed }),
    // A-4. The save runs one upsert per pupil, so it is the slowest call a
    // teacher makes. Without a deadline this route awaited a hung internal
    // request forever: the browser's native form POST was never answered, which
    // is the reported "submitted, no confirmation, no error, no record". 20s is
    // deliberately well under any proxy/browser patience and over a legitimate
    // save. Measured on the isolated verify DB, real 40-pupil class
    // (tmp/_verify_a4_attendance.js): sequential saves 1.6-3.4s; 12 concurrent
    // saves peaked at 5.3s on one run and 12.1s on another, because every
    // upsert serialises on the {student, date} unique index. So the deadline is
    // ~2-4x the worst legitimate case observed — generous for this school's real
    // concurrency (a handful of teachers), and a hung call is still caught well
    // before any browser gives up.
    // The client watchdog in public/js/attendance-mark.js sits BEYOND this value
    // so the server's own message is the one users see.
    timeoutMs: 20000,
  });

  if (result.status !== "success") {
    return res.redirect(`${back}&error=${encodeURIComponent(result.message || "Could not save attendance")}`);
  }

  res.redirect(`${back}&ok=1`);
});

module.exports = router;
