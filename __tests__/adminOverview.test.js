/**
 * Unified Admin Overview — composition-layer tests.
 *
 * The page must remain a PURE DISPLAY layer over the existing services:
 *   1. GUARD — view AND every per-panel JSON route carry requireRole("admin").
 *   2. FINANCE panel = two net-summary calls (today / month-to-date) + the
 *      SAME getDailyTrend the monthly report uses, passed through untouched.
 *   3. ATTENTION panel buckets getTeacherPayConfigsService rows verbatim
 *      (hasConfig / effectiveNow) and lists staff with no expected arrival
 *      time via the SAME active-teacher predicate (isWithdrawn ≠ true).
 *   4. ATTENDANCE panel reuses getTeacherAttendanceDayService; summary and
 *      settings pass through unchanged; late list = rows already flagged
 *      isLate (no re-derivation).
 *   5. ACTIVITY panel = getAuditLogsService page 1, limit 8, mapped fields.
 *   6. FAIL-SOFT — a service failure or throw answers { ok:false, error }
 *      (HTTP 200 JSON), never a 500: one broken panel can't sink the page.
 */

// ── Service / model mocks (factory pattern keeps require safe) ──────────────
const mockNetSummary = jest.fn();
const mockDailyTrend = jest.fn();
const mockPayConfigs = jest.fn();
const mockAttDay = jest.fn();
const mockAuditLogs = jest.fn();
const mockTeacherFind = jest.fn();

jest.mock("../services/finance/netSummary.service", () => ({
  getNetSummaryService: (...a) => mockNetSummary(...a),
}));
jest.mock("../services/finance/financeTrend.service", () => ({
  getMonthlyTrend: jest.fn(),
  getDailyTrend: (...a) => mockDailyTrend(...a),
}));
jest.mock("../services/staff/teacherSalary.service", () => ({
  getTeacherPayConfigsService: (...a) => mockPayConfigs(...a),
}));
jest.mock("../services/staff/teacherAttendance.service", () => ({
  getTeacherAttendanceDayService: (...a) => mockAttDay(...a),
}));
jest.mock("../services/audit/auditLog.service", () => ({
  getAuditLogsService: (...a) => mockAuditLogs(...a),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  find: (...a) => mockTeacherFind(...a),
}));

// Guard spy — the REAL requireRole matrix is covered by the access suites;
// here we only assert every route WIRINGS it with "admin". The factory is
// fixed (never cleared between tests) so router wiring survives beforeEach.
const adminGuardStub = function adminGuard(req, res, next) { next(); };
const mockRequireRole = jest.fn((role) => adminGuardStub);
jest.mock("../middlewares/authView", () => ({
  requireRole: (...roles) => mockRequireRole(...roles),
  requireAdminOrManager: jest.fn(),
}));

const viewRouter = require("../routes/views/adminOverview.views");
const { todayKey } = require("../utils/dateRange");

function handlerFor(path) {
  const layer = viewRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  if (!layer) throw new Error(`No GET route for ${path}`);
  return layer;
}
// stack[0] = requireRole("admin") guard; stack[1] = the handler.
const handlerFnFor = (path) => handlerFor(path).route.stack[1].handle;

const jsonRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
};
const ok = (data) => ({ status: "success", data });

// Teacher lean-chain: find().select().sort().lean() all return the same stub.
const teacherChain = (rows) => {
  const chain = { select: () => chain, sort: () => chain, lean: () => Promise.resolve(rows) };
  return chain;
};

// Router registration ran ONCE at require time — snapshot the guard wiring
// here, before any clearAllMocks can erase those module-load calls.
const GUARD_CALLS_AT_LOAD = mockRequireRole.mock.calls.map((c) => [...c]);

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireRole.mockImplementation((role) => adminGuardStub);
  mockTeacherFind.mockReturnValue(teacherChain([]));
});

it("wires requireRole('admin') — never manager — on every registered route", () => {
  expect(GUARD_CALLS_AT_LOAD.length).toBe(5);
  expect(GUARD_CALLS_AT_LOAD.every((c) => c.length === 1 && c[0] === "admin")).toBe(true);
});

// ══ 1. ADMIN-ONLY GUARD ON EVERY ROUTE ══════════════════════════════════════
describe("route wiring", () => {
  const ALL_PATHS = [
    "/admin/overview",
    "/admin/overview/data/finance",
    "/admin/overview/data/attention",
    "/admin/overview/data/attendance",
    "/admin/overview/data/activity",
  ];

  it.each(ALL_PATHS)("GET %s exists and is guarded by requireRole('admin')", (path) => {
    const layer = handlerFor(path);
    expect(layer.route.stack.length).toBe(2);
    expect(layer.route.stack[0].handle.name).toBe("adminGuard");
  });

  it("view handler renders the overview template with page=admin-overview", async () => {
    const res = { render: jest.fn(), locals: {} };
    await handlerFnFor("/admin/overview")({ user: { role: "admin", name: "Ada" } }, res);
    const [view, opts] = res.render.mock.calls[0];
    expect(view).toBe("admin/overview");
    expect(opts.page).toBe("admin-overview");
    expect(opts.user.role).toBe("admin");
  });
});

// ══ 2. FINANCE PANEL — pure pass-through of existing services ═══════════════
describe("finance panel", () => {
  const TODAY_SUMMARY = { collections: 100, income: 20, expenses: 30, net: 90, counts: {} };
  const MONTH_SUMMARY = { collections: 900, income: 150, expenses: 400, net: 650, counts: {} };
  const TREND = { month: "2026-11", days: [{ date: "2026-11-01", day: 1, ok: true, net: 5 }] };

  const financeHandler = () => handlerFnFor("/admin/overview/data/finance");

  it("composes today + month-to-date net and the daily trend, untouched", async () => {
    mockNetSummary
      .mockImplementationOnce(async (q, res) => res.status(200).json(ok(q.from === todayKey() ? TODAY_SUMMARY : MONTH_SUMMARY)))
      .mockImplementationOnce(async (q, res) => res.status(200).json(ok(MONTH_SUMMARY)));
    mockDailyTrend.mockResolvedValue(TREND);

    const res = jsonRes();
    await financeHandler()({}, res);

    expect(res.body).toEqual({
      ok: true,
      data: {
        date: todayKey(),
        month: todayKey().slice(0, 7), // "YYYY-MM" string for the caption
        today: { collections: 100, income: 20, expenses: 30, net: 90 },
        monthToDate: { collections: 900, income: 150, expenses: 400, net: 650 },
        sparkline: TREND, // verbatim — the client only plots days[].net
      },
    });
    // Ranges: today is a single-day range; month runs from the 1st to today.
    const ranges = mockNetSummary.mock.calls.map((c) => c[0]);
    expect(ranges[0]).toEqual({ from: todayKey(), to: todayKey() });
    expect(ranges[1]).toEqual({ from: `${todayKey().slice(0, 7)}-01`, to: todayKey() });
    expect(mockDailyTrend).toHaveBeenCalledWith(todayKey().slice(0, 7));
  });

  it("fail-soft: service failure envelope → { ok:false, error }, never a 500", async () => {
    mockNetSummary.mockImplementation(async (q, res) => res.status(400).json({ status: "failed", message: "Invalid date" }));
    mockDailyTrend.mockResolvedValue(TREND);

    const res = jsonRes();
    await financeHandler()({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "Invalid date" });
  });

  it("fail-soft: trend rejection sinks only this panel", async () => {
    mockNetSummary.mockImplementation(async (q, res) => res.status(200).json(ok(TODAY_SUMMARY)));
    mockDailyTrend.mockRejectedValue(new Error("db down"));

    const res = jsonRes();
    await financeHandler()({}, res);
    expect(res.body).toEqual({ ok: false, error: "db down" });
  });

  it("fail-soft: trend { error } (range validation) is surfaced as panel error", async () => {
    mockNetSummary.mockImplementation(async (q, res) => res.status(200).json(ok(TODAY_SUMMARY)));
    mockDailyTrend.mockResolvedValue({ error: "Invalid month" });

    const res = jsonRes();
    await financeHandler()({}, res);
    expect(res.body).toEqual({ ok: false, error: "Invalid month" });
  });
});

// ══ 3. ATTENTION PANEL — "not set" aggregation ══════════════════════════════
describe("attention panel", () => {
  const attentionHandler = () => handlerFnFor("/admin/overview/data/attention");

  const PAY_ROWS = [
    { teacher: "t1", name: "With Config", teacherId: "", hasConfig: true, effectiveNow: true, current: { payType: "monthly", rateAmount: 50000, effectiveFrom: "2026-01-01" }, history: [] },
    { teacher: "t2", name: "No Config", teacherId: "", hasConfig: false, effectiveNow: false, current: null, history: [] },
    { teacher: "t3", name: "Scheduled", teacherId: "", hasConfig: true, effectiveNow: false, current: { payType: "monthly", rateAmount: 40000, effectiveFrom: "2027-01-01" }, history: [] },
  ];

  it("buckets pay rows verbatim and links fixes to the real routes", async () => {
    mockTeacherFind.mockReturnValue(teacherChain([
      { _id: "x1", name: "Bob No Time", teacherId: "T-9" },
      { _id: "x2", name: "Ann No Time", teacherId: "" },
    ]));
    mockPayConfigs.mockImplementation(async (res) => res.status(200).json(ok(PAY_ROWS)));

    const res = jsonRes();
    await attentionHandler()({}, res);

    expect(res.body.ok).toBe(true);
    const d = res.body.data;
    expect(d.counts).toEqual({ noExpectedTime: 2, noPayConfig: 1, payNotEffective: 1 });
    expect(d.totalStaff).toBe(3);
    // Per-teacher fix → the existing staff edit page; pay fixes → config page.
    expect(d.noExpectedTime[0]).toEqual({ id: "x1", name: "Bob No Time", teacherId: "T-9", fixUrl: "/staff/x1/edit" });
    expect(d.noExpectedTime[1].fixUrl).toBe("/staff/x2/edit");
    expect(d.noPayConfig).toEqual([{ id: "t2", name: "No Config", fixUrl: "/teacher-salary/config" }]);
    expect(d.payNotEffective[0].effectiveFrom).toBe("2027-01-01");
  });

  it("queries staff with the SAME active predicate + unset expected time", async () => {
    mockPayConfigs.mockImplementation(async (res) => res.status(200).json(ok([])));
    await attentionHandler()({}, jsonRes());

    expect(mockTeacherFind).toHaveBeenCalledWith(
      expect.objectContaining({ isWithdrawn: { $ne: true } })
    );
    const query = mockTeacherFind.mock.calls[0][0];
    expect(query.expectedArrivalTime).toEqual({ $in: ["", null] });
  });

  it("fail-soft: pay-config service failure → { ok:false, error }", async () => {
    mockPayConfigs.mockImplementation(async (res) => res.status(500).json({ status: "failed", message: "boom" }));
    const res = jsonRes();
    await attentionHandler()({}, res);
    expect(res.body).toEqual({ ok: false, error: "boom" });
  });
});

// ══ 4. ATTENDANCE PANEL — day service pass-through ══════════════════════════
describe("attendance panel", () => {
  const attendanceHandler = () => handlerFnFor("/admin/overview/data/attendance");

  const DAY = {
    date: "2026-11-12",
    teachers: [
      { name: "On Time", marked: true, isLate: false, lateMinutes: 0 },
      { name: "Late Lee", marked: true, isLate: true, lateMinutes: 12 },
      { name: "No Time Yet", marked: true, isLate: true, lateMinutes: 30 },
      { name: "Unmarked", marked: false, isLate: false, lateMinutes: 0 },
    ],
    settings: { lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 5 },
    summary: { marked: 3, totalTeachers: 4, totalMinutes: 300, lateCount: 2 },
  };

  it("passes summary/settings through and lists only rows the service flagged late", async () => {
    mockAttDay.mockImplementation(async (date, res) => {
      expect(date).toBe(todayKey());
      return res.status(200).json(ok(DAY));
    });

    const res = jsonRes();
    await attendanceHandler()({}, res);

    const d = res.body.data;
    expect(d.summary).toEqual(DAY.summary); // verbatim — never recomputed here
    expect(d.settings).toEqual(DAY.settings);
    expect(d.late).toEqual([
      { name: "Late Lee", lateMinutes: 12 },
      { name: "No Time Yet", lateMinutes: 30 },
    ]);
    expect(d.notYetMarkedCount).toBe(1);
  });

  it("fail-soft: invalid day response → panel error", async () => {
    mockAttDay.mockImplementation(async (date, res) => res.status(400).json({ status: "failed", message: "Invalid date" }));
    const res = jsonRes();
    await attendanceHandler()({}, res);
    expect(res.body).toEqual({ ok: false, error: "Invalid date" });
  });
});

// ══ 5. ACTIVITY PANEL — audit viewer pass-through ═══════════════════════════
describe("activity panel", () => {
  const activityHandler = () => handlerFnFor("/admin/overview/data/activity");

  it("asks the audit service for the newest 8 and maps display fields only", async () => {
    mockAuditLogs.mockImplementation(async (filters, res) => {
      expect(filters).toEqual({ page: 1, limit: 8 });
      return res.status(200).json(ok({
        logs: [{
          _id: "l1", timestamp: "2026-11-12T07:30:00.000Z", userName: "Ada", userRole: "admin",
          actionType: "create", entityType: "expense_entry", summary: "Created expense Rent", secret: "x",
        }],
        pagination: { page: 1 },
      }));
    });

    const res = jsonRes();
    await activityHandler()({}, res);

    // Whitelisted fields only — raw snapshots/_id never leave the endpoint.
    expect(res.body).toEqual({
      ok: true,
      data: {
        entries: [{
          timestamp: "2026-11-12T07:30:00.000Z",
          userName: "Ada", userRole: "admin", actionType: "create", entityType: "expense_entry",
          summary: "Created expense Rent",
        }],
      },
    });
  });

  it("fail-soft: audit service throw → panel error, not a crash", async () => {
    mockAuditLogs.mockRejectedValue(new Error("audit db hiccup"));
    const res = jsonRes();
    await activityHandler()({}, res);
    expect(res.body).toEqual({ ok: false, error: "audit db hiccup" });
  });
});
