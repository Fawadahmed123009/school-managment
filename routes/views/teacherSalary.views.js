const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");
const { localDateKey } = require("../../utils/localDateKey");
const { formatMinutes } = require("../../utils/teacherAttendanceTime");

// Teacher salary — Phase 2. ADMIN ONLY on every route (requireRole resolves
// the role from the DB via authView): managers never see pay rates, salary
// amounts or run history anywhere in their UI.

// ── helpers ─────────────────────────────────────────────────────────────────

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const safeDate = (str, fallback) => (DATE_RE.test(String(str)) ? str : fallback);

// Money display follows the fees views ("Rs"), keeping 2 decimals for
// hour-based amounts.
const fmtRs = (n) => "Rs " + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// ── Salary runs: generation form + run history ──────────────────────────────

router.get("/teacher-salary", requireRole("admin"), async (req, res) => {
  const now = new Date();
  const todayISO = toISODate(now);
  const monthFirst = toISODate(new Date(now.getFullYear(), now.getMonth(), 1));

  const teacherId = req.query.teacherId || "";
  const status = req.query.status === "draft" || req.query.status === "finalized" ? req.query.status : "";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (teacherId) params.set("teacherId", teacherId);
  if (status) params.set("status", status);

  const [configsRes, runsRes, settingsRes, phase1Res] = await Promise.all([
    apiFetch("/teacher-salary/configs", req.token),
    apiFetch(`/teacher-salary/runs?${params.toString()}`, req.token),
    apiFetch("/teacher-salary/settings", req.token),
    apiFetch("/teacher-attendance/settings", req.token),
  ]);

  const configs = configsRes.status === "success" ? configsRes.data : [];
  const runsData = runsRes.status === "success" ? runsRes.data : { runs: [], pagination: null };
  const settings = settingsRes.status === "success"
    ? settingsRes.data
    : { lateDeductionEnabled: false, deductionType: "flat", flatAmount: 0, percentValue: 0 };
  const phase1 = phase1Res.status === "success" ? phase1Res.data : { lateDetectionEnabled: false };

  const runs = (runsData.runs || []).map((r) => ({
    ...r,
    startKey: localDateKey(r.periodStart),
    endKey: localDateKey(r.periodEnd),
    teacherName: r.teacher ? r.teacher.name : "Unknown",
    gross: fmtRs(r.grossAmount),
    deduction: fmtRs(r.lateDeductionAmount),
    net: fmtRs(r.netAmount),
  }));

  res.render("teacher-salary/runs", {
    page: "teacher-salary",
    user: req.user,
    configs,
    runs,
    pagination: runsData.pagination || { total: 0, page: 1, pages: 0, hasPrev: false, hasNext: false },
    teacherId,
    status,
    settings,
    phase1,
    defaultStart: safeDate(req.query.startDate, monthFirst),
    defaultEnd: safeDate(req.query.endDate, todayISO),
    ok: req.query.ok === "1",
    error: req.query.error || "",
    loadError: configsRes.status === "success" ? null : configsRes.message,
    fmtRs,
    schoolName: res.locals.schoolName,
  });
});

// AJAX dry run — proxies the admin-only API preview (zero writes server-side).
router.post("/teacher-salary/preview", requireRole("admin"), async (req, res) => {
  const { teacherId, startDate, endDate, lectureCount } = req.body || {};
  const result = await apiFetch("/teacher-salary/preview", req.token, {
    method: "POST",
    body: JSON.stringify({ teacherId, startDate, endDate, lectureCount }),
  });
  res.json(result);
});

// Generate a draft — the API recomputes everything; form amounts are never
// trusted. Redirects to the new run's detail page.
router.post("/teacher-salary/generate", requireRole("admin"), async (req, res) => {
  const { teacherId, startDate, endDate, lectureCount } = req.body;
  const result = await apiFetch("/teacher-salary/runs", req.token, {
    method: "POST",
    body: JSON.stringify({ teacherId, startDate, endDate, lectureCount }),
  });
  if (result.status !== "success") {
    return res.redirect(`/teacher-salary?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect(`/teacher-salary/runs/${result.data.run._id}?ok=1`);
});

// ── Run detail (snapshot + finalize / delete-draft) ─────────────────────────

router.get("/teacher-salary/runs/:id", requireRole("admin"), async (req, res) => {
  const runRes = await apiFetch(`/teacher-salary/runs/${req.params.id}`, req.token);
  if (runRes.status !== "success") {
    return res.status(404).render("error", {
      title: "Salary run not found",
      message: runRes.message || "This salary run does not exist.",
      schoolName: res.locals.schoolName,
    });
  }
  const run = runRes.data;

  res.render("teacher-salary/run-detail", {
    page: "teacher-salary",
    user: req.user,
    run: {
      ...run,
      startKey: localDateKey(run.periodStart),
      endKey: localDateKey(run.periodEnd),
      teacherName: run.teacher ? run.teacher.name : "Unknown",
      teacherCode: run.teacher ? run.teacher.teacherId || "" : "",
      gross: fmtRs(run.grossAmount),
      deduction: fmtRs(run.lateDeductionAmount),
      net: fmtRs(run.netAmount),
      segments: (run.segments || []).map((s) => ({
        ...s,
        effectiveKey: localDateKey(s.effectiveFrom),
        amountFmt: fmtRs(s.amount),
        rateFmt: fmtRs(s.rateAmount),
      })),
      days: (run.days || []).map((d) => ({
        ...d,
        dateKey: localDateKey(d.date),
        duration: formatMinutes(d.workingMinutes),
      })),
    },
    ok: req.query.ok === "1",
    error: req.query.error || "",
    fmtRs,
    formatMinutes,
    schoolName: res.locals.schoolName,
  });
});

router.post("/teacher-salary/runs/:id/finalize", requireRole("admin"), async (req, res) => {
  const result = await apiFetch(`/teacher-salary/runs/${req.params.id}/finalize`, req.token, { method: "PUT" });
  if (result.status !== "success") {
    return res.redirect(`/teacher-salary/runs/${req.params.id}?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect(`/teacher-salary/runs/${req.params.id}?ok=1`);
});

router.post("/teacher-salary/runs/:id/delete", requireRole("admin"), async (req, res) => {
  const result = await apiFetch(`/teacher-salary/runs/${req.params.id}`, req.token, { method: "DELETE" });
  if (result.status !== "success") {
    return res.redirect(`/teacher-salary/runs/${req.params.id}?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect(`/teacher-salary?ok=1`);
});

// ── Pay rates & deduction rule (admin only) ─────────────────────────────────

router.get("/teacher-salary/config", requireRole("admin"), async (req, res) => {
  const [configsRes, settingsRes, phase1Res] = await Promise.all([
    apiFetch("/teacher-salary/configs", req.token),
    apiFetch("/teacher-salary/settings", req.token),
    apiFetch("/teacher-attendance/settings", req.token),
  ]);

  const configs = (configsRes.status === "success" ? configsRes.data : []).map((c) => ({
    ...c,
    current: c.current
      ? { ...c.current, effectiveKey: localDateKey(c.current.effectiveFrom), rateFmt: fmtRs(c.current.rateAmount) }
      : null,
    history: (c.history || []).map((h) => ({
      ...h,
      effectiveKey: localDateKey(h.effectiveFrom),
      rateFmt: fmtRs(h.rateAmount),
    })),
  }));
  const settings = settingsRes.status === "success"
    ? settingsRes.data
    : { lateDeductionEnabled: false, deductionType: "flat", flatAmount: 0, percentValue: 0 };
  const phase1 = phase1Res.status === "success" ? phase1Res.data : { lateDetectionEnabled: false };

  res.render("teacher-salary/config", {
    page: "teacher-salary-config",
    user: req.user,
    configs,
    settings,
    phase1,
    todayISO: toISODate(new Date()),
    ok: req.query.ok === "1",
    error: req.query.error || "",
    loadError: configsRes.status === "success" ? null : configsRes.message,
    fmtRs,
    schoolName: res.locals.schoolName,
  });
});

// Insert a NEW rate row (history is never overwritten).
router.post("/teacher-salary/config/rate", requireRole("admin"), async (req, res) => {
  const { teacher, payType, rateAmount, effectiveFrom } = req.body;
  const result = await apiFetch("/teacher-salary/configs", req.token, {
    method: "POST",
    body: JSON.stringify({ teacher, payType, rateAmount, effectiveFrom }),
  });
  if (result.status !== "success") {
    return res.redirect(`/teacher-salary/config?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect("/teacher-salary/config?ok=1");
});

// Deduction rule write (Phase 2 settings — the Phase 1 late rule is untouched).
router.post("/teacher-salary/config/settings", requireRole("admin"), async (req, res) => {
  const result = await apiFetch("/teacher-salary/settings", req.token, {
    method: "PUT",
    body: JSON.stringify({
      // Unchecked checkboxes are absent from the form body → disabled.
      lateDeductionEnabled: req.body.lateDeductionEnabled === "on",
      deductionType: req.body.deductionType,
      flatAmount: req.body.flatAmount,
      percentValue: req.body.percentValue,
    }),
  });
  if (result.status !== "success") {
    return res.redirect(`/teacher-salary/config?error=${encodeURIComponent(result.message)}`);
  }
  res.redirect("/teacher-salary/config?ok=1");
});

module.exports = router;