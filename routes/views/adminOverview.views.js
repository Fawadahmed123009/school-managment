const express = require("express");
const router = express.Router();
const Teacher = require("../../models/Staff/teachers.model");
const { requireRole } = require("../../middlewares/authView");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const { todayKey } = require("../../utils/dateRange");
const { getNetSummaryService } = require("../../services/finance/netSummary.service");
const { getDailyTrend } = require("../../services/finance/financeTrend.service");
const { getTeacherPayConfigsService } = require("../../services/staff/teacherSalary.service");
const { getTeacherAttendanceDayService } = require("../../services/staff/teacherAttendance.service");
const { getAuditLogsService } = require("../../services/audit/auditLog.service");

// ── Unified Admin Overview — the admin landing page that ties the system
// together. ADMIN ONLY on every route (view AND per-panel JSON), read-only.
//
// PURE COMPOSITION: this file adds NO calculation logic. Every number comes
// from the SAME service the dedicated page already uses (net-summary, the
// daily-trend sparkline source, pay configs, teacher-attendance day, audit
// logs), called through the shared captureServiceResponse adapter. If a
// figure here ever disagrees with its source page, that is a bug HERE.
//
// Panels load INDEPENDENTLY on the client: the view renders an empty shell
// and each panel fetches its own JSON endpoint, so the slowest query can
// never block the rest of the page. Every endpoint is fail-soft — a service
// failure becomes a per-panel error the user can retry, never a 500.

// ACTIVE_TEACHER_FILTER mirror — the exact same predicate the staff/attendance
// and salary services use, so "who counts as a teacher" can never drift here.
const ACTIVE_TEACHER_FILTER = { isWithdrawn: { $ne: true } };

// Run an API-style service and unwrap its success payload, or throw a plain
// message the endpoint layer converts into a fail-soft panel error.
async function callService(fn, ...args) {
  const { res, result } = captureServiceResponse();
  await fn(...args, res);
  if (!result.ok) throw new Error(result.message || "Service responded with a failure");
  return result.body.data;
}

// Uniform JSON envelope for the panel fetches (never errors on the HTML page).
function panelOk(res, data) {
  return res.json({ ok: true, data });
}
function panelFail(res, err) {
  return res.json({ ok: false, error: (err && err.message) || "Panel data could not be loaded" });
}

// ── page shell — renders instantly, panels fill themselves in ───────────────
router.get("/admin/overview", requireRole("admin"), async (req, res) => {
  res.render("admin/overview", {
    page: "admin-overview",
    user: req.user,
    schoolName: res.locals.schoolName,
  });
});

// ── finance snapshot: today + this month net, from the net-summary core;
//    sparkline from the SAME daily-trend composition the monthly report uses ──
router.get("/admin/overview/data/finance", requireRole("admin"), async (req, res) => {
  try {
    const today = todayKey();
    const month = today.slice(0, 7);

    // Independent fetches — one Promise.all, no sequencing.
    const [todaySummary, monthSummary, trend] = await Promise.all([
      callService(getNetSummaryService, { from: today, to: today }),
      callService(getNetSummaryService, { from: `${month}-01`, to: today }),
      getDailyTrend(month), // already fail-soft per point; returns { month, days }
    ]);

    if (trend && trend.error) throw new Error(trend.error);

    return panelOk(res, {
      date: today,
      month, // "YYYY-MM" string — the sparkline caption labels with this
      today: { collections: todaySummary.collections, income: todaySummary.income, expenses: todaySummary.expenses, net: todaySummary.net },
      monthToDate: { collections: monthSummary.collections, income: monthSummary.income, expenses: monthSummary.expenses, net: monthSummary.net },
      // Passed through untouched — the client only plots days[].net.
      sparkline: trend,
    });
  } catch (err) {
    return panelFail(res, err);
  }
});

// ── attention-needed: aggregated "not set" flags from the existing systems ──
//   • staff without an expected arrival time  (Phase 1 late detection can
//     never judge them — the one read-only here is a plain profile query
//     with the SAME active-teacher predicate the attendance service uses)
//   • staff with no pay config, or a config that is not effective yet
//     (salary runs fail closed for them — via getTeacherPayConfigsService)
router.get("/admin/overview/data/attention", requireRole("admin"), async (req, res) => {
  try {
    const [staffNoTime, payRows] = await Promise.all([
      Teacher.find({ ...ACTIVE_TEACHER_FILTER, expectedArrivalTime: { $in: ["", null] } })
        .select("name teacherId")
        .sort({ name: 1 })
        .lean(),
      callService(getTeacherPayConfigsService),
    ]);

    const noPayConfig = payRows.filter((r) => !r.hasConfig);
    const notEffectiveYet = payRows.filter((r) => r.hasConfig && !r.effectiveNow);

    return panelOk(res, {
      counts: {
        noExpectedTime: staffNoTime.length,
        noPayConfig: noPayConfig.length,
        payNotEffective: notEffectiveYet.length,
      },
      // fix URLs mirror the real routes: per-teacher edit + the pay-config page
      noExpectedTime: staffNoTime.map((t) => ({
        id: String(t._id),
        name: t.name,
        teacherId: t.teacherId || "",
        fixUrl: `/staff/${t._id}/edit`,
      })),
      noPayConfig: noPayConfig.map((r) => ({ id: String(r.teacher), name: r.name, fixUrl: "/teacher-salary/config" })),
      payNotEffective: notEffectiveYet.map((r) => ({
        id: String(r.teacher),
        name: r.name,
        effectiveFrom: r.current ? r.current.effectiveFrom : null,
        fixUrl: "/teacher-salary/config",
      })),
      totalStaff: payRows.length,
    });
  } catch (err) {
    return panelFail(res, err);
  }
});

// ── attendance snapshot: today's staff day, from the day service the
//    marking page itself uses. Counting display rows (who is late / not yet
//    marked) is presentation, not a second calculation path. ──────────────────
router.get("/admin/overview/data/attendance", requireRole("admin"), async (req, res) => {
  try {
    const today = todayKey();
    const day = await callService(getTeacherAttendanceDayService, today);

    const teachers = day.teachers || [];
    const late = teachers.filter((t) => t.marked && t.isLate);
    const notYetMarked = teachers.filter((t) => !t.marked);

    return panelOk(res, {
      date: day.date,
      summary: day.summary, // { marked, totalTeachers, totalMinutes, lateCount } — as the service returns it
      settings: day.settings,
      late: late.map((t) => ({ name: t.name, lateMinutes: t.lateMinutes })),
      notYetMarkedCount: notYetMarked.length,
    });
  } catch (err) {
    return panelFail(res, err);
  }
});

// ── recent activity: the last few audit-log entries, straight from the
//    viewer service (username resolution included) ───────────────────────────
router.get("/admin/overview/data/activity", requireRole("admin"), async (req, res) => {
  try {
    const { logs } = await callService(getAuditLogsService, { page: 1, limit: 8 });
    return panelOk(res, {
      entries: logs.map((l) => ({
        timestamp: l.timestamp,
        userName: l.userName,
        userRole: l.userRole,
        actionType: l.actionType,
        entityType: l.entityType,
        summary: l.summary,
      })),
    });
  } catch (err) {
    return panelFail(res, err);
  }
});

module.exports = router;
