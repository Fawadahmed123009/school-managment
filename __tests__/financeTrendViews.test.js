/**
 * View-integration tests for the finance trend visual layer:
 * - Yearly report page composes getMonthlyTrend(year); monthly page composes
 *   getDailyTrend(month); daily page composes NEITHER.
 * - Trend data is handed to the template untouched (pure pass-through).
 * - FAIL-SOFT: a trend rejection or { error } never breaks the tabular
 *   report — the page still renders with trendError set.
 * - No trend composition runs when the report itself failed to load.
 * - The admin-only guard and read-only GET wiring are unchanged
 *   (financeReportAccess.test.js covers the guard matrix).
 */

jest.mock("../services/finance/financeReport.service", () => ({
  getFinanceReportService: jest.fn(),
  resolveReportRange: jest.fn(),
}));
jest.mock("../services/finance/financeTrend.service", () => ({
  getMonthlyTrend: jest.fn(),
  getDailyTrend: jest.fn(),
}));
jest.mock("../services/finance/financeExport.service", () => ({
  normalizeExportFormat: jest.fn(),
  fetchReportForExport: jest.fn(),
  buildFinanceReportExport: jest.fn(),
  financeReportFilename: jest.fn(),
}));
jest.mock("../utils/exportFile", () => ({ sendExport: jest.fn() }));

const { getFinanceReportService } = require("../services/finance/financeReport.service");
const { getMonthlyTrend, getDailyTrend } = require("../services/finance/financeTrend.service");
const viewRouter = require("../routes/views/financeReport.views");

function handlerFor(path) {
  const layer = viewRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  // stack[0] = requireRole("admin") guard; stack[1] = the view handler.
  return layer.route.stack[1].handle;
}

const FAKE_REPORT = {
  mode: "yearly",
  from: "2026-01-01",
  to: "2026-12-31",
  collections: 1000,
  income: 200,
  expenses: 300,
  salaries: 400,
  netBeforeSalaries: 900,
  net: 500,
  counts: { collections: 1, income: 1, expenses: 1, salaries: 1 },
  incomeByHead: [{ headId: "h1", name: "Donations", isActive: true, total: 200, count: 1 }],
  expensesByHead: [{ headId: "h2", name: "Rent", isActive: true, total: 300, count: 1 }],
  salaryByTeacher: [],
  salaryRuns: [],
};

function mockRes() {
  return { render: jest.fn(), locals: { schoolName: "Test School" } };
}
const renderArgs = (res) => res.render.mock.calls[0];

beforeEach(() => {
  jest.clearAllMocks();
  getFinanceReportService.mockImplementation(async (query, res) =>
    res.status(200).json({ status: "success", data: { ...FAKE_REPORT, mode: query.mode } })
  );
  getMonthlyTrend.mockResolvedValue({ year: "2026", months: [{ month: "2026-01", label: "Jan", ok: true, net: 60 }] });
  getDailyTrend.mockResolvedValue({ month: "2026-11", days: [{ date: "2026-11-01", day: 1, ok: true, net: 60 }] });
});

describe("yearly report page — monthly trend composition", () => {
  it("passes the composed trend to the template untouched", async () => {
    const req = { query: { year: "2026" }, user: { _id: "a1", role: "admin" } };
    const res = mockRes();
    await handlerFor("/finance/yearly-report")(req, res);

    expect(getMonthlyTrend).toHaveBeenCalledWith("2026");
    expect(getDailyTrend).not.toHaveBeenCalled();
    const [template, data] = renderArgs(res);
    expect(template).toBe("finance/report");
    expect(data.report).toBeTruthy();
    expect(data.trend).toEqual({ year: "2026", months: [{ month: "2026-01", label: "Jan", ok: true, net: 60 }] });
    expect(data.dailyTrend).toBeNull();
    expect(data.trendError).toBeNull();
    expect(typeof data.fmtRsCompact).toBe("function");
  });

  it("defaults the picker to the current year when none is given", async () => {
    const req = { query: {}, user: { _id: "a1", role: "admin" } };
    await handlerFor("/finance/yearly-report")(req, mockRes());
    expect(getMonthlyTrend).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}$/));
  });

  it("still renders the tabular report when the trend composition throws", async () => {
    getMonthlyTrend.mockRejectedValue(new Error("trend exploded"));
    const req = { query: { year: "2026" }, user: { _id: "a1", role: "admin" } };
    const res = mockRes();
    await handlerFor("/finance/yearly-report")(req, res);

    const [, data] = renderArgs(res);
    expect(data.report).toBeTruthy();
    expect(data.trend).toBeNull();
    expect(data.trendError).toBe("trend exploded");
    expect(data.loadError).toBeNull();
  });

  it("surfaces a trend { error } as trendError without touching the report", async () => {
    getMonthlyTrend.mockResolvedValue({ error: "Invalid year — expected YYYY" });
    const req = { query: { year: "2026" }, user: { _id: "a1", role: "admin" } };
    const res = mockRes();
    await handlerFor("/finance/yearly-report")(req, res);

    const [, data] = renderArgs(res);
    expect(data.report).toBeTruthy();
    expect(data.trend).toBeNull();
    expect(data.trendError).toBe("Invalid year — expected YYYY");
  });

  it("never composes a trend when the report itself failed to load", async () => {
    getFinanceReportService.mockImplementation(async (query, res) =>
      res.status(400).json({ status: "failed", message: "Invalid year — expected YYYY" })
    );
    const req = { query: { year: "oops" }, user: { _id: "a1", role: "admin" } };
    const res = mockRes();
    await handlerFor("/finance/yearly-report")(req, res);

    expect(getMonthlyTrend).not.toHaveBeenCalled();
    const [, data] = renderArgs(res);
    expect(data.report).toBeNull();
    expect(data.loadError).toBe("Invalid year — expected YYYY");
    expect(data.trend).toBeNull();
  });
});

describe("monthly report page — daily trend composition", () => {
  it("passes the composed daily trend to the template untouched", async () => {
    const req = { query: { month: "2026-11" }, user: { _id: "a1", role: "admin" } };
    const res = mockRes();
    await handlerFor("/finance/monthly-report")(req, res);

    expect(getDailyTrend).toHaveBeenCalledWith("2026-11");
    expect(getMonthlyTrend).not.toHaveBeenCalled();
    const [, data] = renderArgs(res);
    expect(data.dailyTrend).toEqual({ month: "2026-11", days: [{ date: "2026-11-01", day: 1, ok: true, net: 60 }] });
    expect(data.trend).toBeNull();
    expect(data.trendError).toBeNull();
  });

  it("still renders the tabular report when the daily trend throws", async () => {
    getDailyTrend.mockRejectedValue(new Error("daily trend exploded"));
    const req = { query: { month: "2026-11" }, user: { _id: "a1", role: "admin" } };
    const res = mockRes();
    await handlerFor("/finance/monthly-report")(req, res);

    const [, data] = renderArgs(res);
    expect(data.report).toBeTruthy();
    expect(data.dailyTrend).toBeNull();
    expect(data.trendError).toBe("daily trend exploded");
  });
});

describe("daily report page — no trend composition", () => {
  it("renders without calling either trend composer", async () => {
    const req = { query: { date: "2026-11-12" }, user: { _id: "a1", role: "admin" } };
    const res = mockRes();
    await handlerFor("/finance/daily-report")(req, res);

    expect(getMonthlyTrend).not.toHaveBeenCalled();
    expect(getDailyTrend).not.toHaveBeenCalled();
    const [, data] = renderArgs(res);
    expect(data.report).toBeTruthy();
    expect(data.trend).toBeNull();
    expect(data.dailyTrend).toBeNull();
    expect(data.trendError).toBeNull();
  });
});

describe("compact money formatter (donut centers)", () => {
  it("shortens large figures and keeps small ones plain", async () => {
    const req = { query: { year: "2026" }, user: { _id: "a1", role: "admin" } };
    const res = mockRes();
    await handlerFor("/finance/yearly-report")(req, res);
    const fmt = renderArgs(res)[1].fmtRsCompact;
    expect(fmt(0)).toBe("Rs 0");
    expect(fmt(950)).toBe("Rs 950");
    expect(fmt(1500)).toBe("Rs 1.5k");
    expect(fmt(25000)).toBe("Rs 25k");
    expect(fmt(150000)).toBe("Rs 1.5L");
    expect(fmt(2500000)).toBe("Rs 25L");
    expect(fmt(15000000)).toBe("Rs 1.5Cr");
    expect(fmt(250000000)).toBe("Rs 25Cr");
    expect(fmt(-1500)).toBe("Rs -1.5k");
  });
});