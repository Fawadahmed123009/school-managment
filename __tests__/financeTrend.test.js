/**
 * Finance trend composition tests (Phase 4 visual layer):
 * - PURE COMPOSITION: every trend point must be the exact data returned by
 *   getFinanceReportService for that month/day — no recomputation, rounding
 *   or date math of its own (values flow through byte-identical).
 * - Yearly trend = 12 monthly reports (Jan–Dec keys + labels); daily trend =
 *   one daily report per calendar day (leap February included).
 * - Future days are NEVER queried (null points, future:true).
 * - Fail-soft per point: a failed/thrown month or day nulls only that point.
 * - Bounded parallelism: at most 6 report calls in flight at once.
 * - Fail-closed range validation delegated to resolveReportRange (real).
 *
 * getFinanceReportService is mocked at the service boundary; the REAL
 * resolveReportRange + utils/dateRange run so picker rules are asserted exactly.
 */

const mockReport = jest.fn();

jest.mock("../services/finance/financeReport.service", () => ({
  ...jest.requireActual("../services/finance/financeReport.service"),
  getFinanceReportService: (...a) => mockReport(...a),
}));
jest.mock("../utils/dateRange", () => ({
  ...jest.requireActual("../utils/dateRange"),
  todayKey: jest.fn(),
}));

const { getMonthlyTrend, getDailyTrend } = require("../services/finance/financeTrend.service");
const { todayKey } = require("../utils/dateRange");

// Deterministic per-period figures derived from the query so pass-through
// can be asserted exactly (month 03 → collections 300, etc.).
function dataFor(query) {
  const n = query.mode === "monthly" ? Number(query.month.slice(5, 7)) : Number(query.date.slice(8, 10));
  return {
    mode: query.mode,
    from: query.mode === "monthly" ? `${query.month}-01` : query.date,
    to: query.mode === "monthly" ? `${query.month}-28` : query.date,
    collections: n * 100,
    income: n * 10,
    expenses: n * 30,
    salaries: n * 20,
    netBeforeSalaries: n * 80,
    net: n * 60,
    counts: { collections: n, income: n, expenses: n, salaries: 0 },
    incomeByHead: [],
    expensesByHead: [],
    salaryByTeacher: [],
    salaryRuns: [],
  };
}

let inFlight = 0;
let maxInFlight = 0;

function okImplementation() {
  mockReport.mockImplementation(async (query, res) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    res.status(200).json({ status: "success", data: dataFor(query) });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  inFlight = 0;
  maxInFlight = 0;
  todayKey.mockReturnValue("2026-11-12");
  okImplementation();
});

const KEYS = ["collections", "income", "expenses", "salaries", "net"];

describe("getMonthlyTrend — 12 monthly reports across the year", () => {
  it("rejects malformed years fail-closed without any report call", async () => {
    for (const bad of [undefined, "", "26", "2026-01", "abcd", "20x6"]) {
      const out = await getMonthlyTrend(bad);
      expect(out.error).toBeTruthy();
      expect(out.months).toBeUndefined();
    }
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("calls the monthly report once per month with exact YYYY-MM keys", async () => {
    const out = await getMonthlyTrend("2026");
    expect(out.error).toBeUndefined();
    expect(out.year).toBe("2026");
    expect(mockReport).toHaveBeenCalledTimes(12);
    const queries = mockReport.mock.calls.map((c) => c[0]);
    expect(queries).toEqual(
      Array.from({ length: 12 }, (_, i) => ({ mode: "monthly", month: `2026-${String(i + 1).padStart(2, "0")}` }))
    );
    expect(out.months.map((m) => m.label)).toEqual(
      ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    );
    expect(out.months.map((m) => m.month)).toEqual(queries.map((q) => q.month));
  });

  it("passes report figures through unchanged (pure visualization, no recomputation)", async () => {
    const out = await getMonthlyTrend("2026");
    out.months.forEach((m, i) => {
      const expected = dataFor({ mode: "monthly", month: `2026-${String(i + 1).padStart(2, "0")}` });
      expect(m.ok).toBe(true);
      KEYS.forEach((k) => expect(m[k]).toBe(expected[k]));
    });
  });

  it("nulls only the failed month when its report responds with a failure envelope", async () => {
    mockReport.mockImplementation(async (query, res) => {
      if (query.month === "2026-03") return res.status(400).json({ status: "failed", message: "boom" });
      return res.status(200).json({ status: "success", data: dataFor(query) });
    });
    const out = await getMonthlyTrend("2026");
    const mar = out.months[2];
    expect(mar.ok).toBe(false);
    KEYS.forEach((k) => expect(mar[k]).toBeNull());
    expect(out.months[1].ok).toBe(true);
    expect(out.months[3].ok).toBe(true);
    expect(out.months[3].net).toBe(4 * 60);
  });

  it("nulls only the thrown month (transient DB error never sinks the trend)", async () => {
    mockReport.mockImplementation(async (query, res) => {
      if (query.month === "2026-07") throw new Error("db hiccup");
      return res.status(200).json({ status: "success", data: dataFor(query) });
    });
    const out = await getMonthlyTrend("2026");
    expect(out.months[6].ok).toBe(false);
    expect(out.months.filter((m) => m.ok)).toHaveLength(11);
  });

  it("runs report calls in parallel but bounded to 6 in flight", async () => {
    await getMonthlyTrend("2026");
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });
});

describe("getDailyTrend — one daily report per calendar day", () => {
  it("rejects malformed months fail-closed without any report call", async () => {
    for (const bad of [undefined, "", "2026", "2026-13", "2026-00", "garbage"]) {
      const out = await getDailyTrend(bad);
      expect(out.error).toBeTruthy();
      expect(out.days).toBeUndefined();
    }
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("queries every day of a past month (28-day February)", async () => {
    const out = await getDailyTrend("2026-02");
    expect(out.days).toHaveLength(28);
    expect(mockReport).toHaveBeenCalledTimes(28);
    expect(mockReport.mock.calls[27][0]).toEqual({ mode: "daily", date: "2026-02-28" });
    out.days.forEach((d, i) => {
      expect(d.date).toBe(`2026-02-${String(i + 1).padStart(2, "0")}`);
      expect(d.day).toBe(i + 1);
      expect(d.ok).toBe(true);
      expect(d.net).toBe((i + 1) * 60);
      expect(d.future).toBeUndefined();
    });
  });

  it("handles leap February (29 days in 2024)", async () => {
    const out = await getDailyTrend("2024-02");
    expect(out.days).toHaveLength(29);
    expect(mockReport).toHaveBeenCalledTimes(29);
    expect(out.days[28].date).toBe("2024-02-29");
  });

  it("never queries future days of the current month — they are null gaps", async () => {
    const out = await getDailyTrend("2026-11"); // today = 2026-11-12
    expect(out.days).toHaveLength(30);
    expect(mockReport).toHaveBeenCalledTimes(12);
    const queried = mockReport.mock.calls.map((c) => c[0].date);
    expect(queried).toEqual(Array.from({ length: 12 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`));
    out.days.slice(12).forEach((d) => {
      expect(d.future).toBe(true);
      expect(d.ok).toBe(true);
      KEYS.forEach((k) => expect(d[k]).toBeNull());
    });
    expect(out.days[11].net).toBe(12 * 60);
  });

  it("queries nothing for a fully future month", async () => {
    const out = await getDailyTrend("2026-12");
    expect(out.days).toHaveLength(31);
    expect(out.days.every((d) => d.future === true)).toBe(true);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("nulls only the failed day and keeps day order", async () => {
    mockReport.mockImplementation(async (query, res) => {
      if (query.date === "2026-10-05") throw new Error("db hiccup");
      return res.status(200).json({ status: "success", data: dataFor(query) });
    });
    const out = await getDailyTrend("2026-10");
    expect(out.days).toHaveLength(31);
    expect(out.days[4].ok).toBe(false);
    expect(out.days[4].net).toBeNull();
    expect(out.days[3].net).toBe(4 * 60);
    expect(out.days[5].net).toBe(6 * 60);
    expect(out.days.map((d) => d.day)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });

  it("runs daily report calls bounded to 6 in flight", async () => {
    await getDailyTrend("2026-10");
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(6);
  });
});