/**
 * Phase 4 financial reporting tests (daily / monthly / yearly):
 * - Fail-closed validation: mode + picker value required and well-formed —
 *   otherwise 400 and NO query runs.
 * - Every mode resolves to an inclusive LOCAL range through utils/dateRange
 *   (monthly/yearly are just wider daily ranges — no second date path).
 * - Totals compose the shared net-summary core (same pipelines as the live
 *   /net-summary endpoint); salaries = FINALIZED runs whose finalizedAt falls
 *   in the range (drafts never count), summed on netAmount, grouped per teacher.
 * - Net = collections + income − expenses − salaries (Admin-confirmed);
 *   netBeforeSalaries always equals the core net. Loss + round2 allowed.
 * - Head breakdowns map names in one follow-up find; unknown heads fail soft.
 *
 * Models are mocked at the data layer; utils/dateRange runs for real so the
 * inclusive local-midnight bounds are asserted exactly.
 */

const mockFeesAggregate = jest.fn();
const mockIncomeAggregate = jest.fn();
const mockExpenseAggregate = jest.fn();
const mockIncomeHeadFind = jest.fn();
const mockExpenseHeadFind = jest.fn();
const mockSalaryFind = jest.fn();

jest.mock("../models/Fees/fees.model", () => ({
  aggregate: (...a) => mockFeesAggregate(...a),
}));
jest.mock("../models/Income/incomeEntry.model", () => ({
  aggregate: (...a) => mockIncomeAggregate(...a),
}));
jest.mock("../models/Expenses/expenseEntry.model", () => ({
  aggregate: (...a) => mockExpenseAggregate(...a),
}));
jest.mock("../models/Income/incomeHead.model", () => ({
  find: (...a) => mockIncomeHeadFind(...a),
}));
jest.mock("../models/Expenses/expenseHead.model", () => ({
  find: (...a) => mockExpenseHeadFind(...a),
}));
jest.mock("../models/Staff/teacherSalaryRun.model", () => ({
  find: (...a) => mockSalaryFind(...a),
}));

const { getFinanceReportService, resolveReportRange } = require("../services/finance/financeReport.service");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];

// IncomeEntry/ExpenseEntry.aggregate is called TWICE per report: the core
// total (_id: null) and the head breakdown (_id: "$head"). Dispatch on shape.
function entryMock(mock, { total = 0, count = 0, groups = [] } = {}) {
  mock.mockImplementation(async (pipeline) => {
    const group = pipeline.find((s) => s.$group).$group;
    if (group._id === null) return [{ _id: null, total, count }];
    return groups;
  });
}
const headFindMock = (mock, heads) =>
  mock.mockReturnValue({ select: () => ({ lean: async () => heads }) });
const salaryFindMock = (runs) =>
  mockSalaryFind.mockReturnValue({
    populate: () => ({ sort: () => ({ lean: async () => runs }) }),
  });

function setScenario({ fees = 0, income = 0, expenses = 0, counts = {}, incomeGroups = [], expenseGroups = [], incomeHeads = [], expenseHeads = [], runs = [] } = {}) {
  mockFeesAggregate.mockResolvedValue([{ _id: null, total: fees, count: counts.collections || 0 }]);
  entryMock(mockIncomeAggregate, { total: income, count: counts.income || 0, groups: incomeGroups });
  entryMock(mockExpenseAggregate, { total: expenses, count: counts.expenses || 0, groups: expenseGroups });
  headFindMock(mockIncomeHeadFind, incomeHeads);
  headFindMock(mockExpenseHeadFind, expenseHeads);
  salaryFindMock(runs);
}

beforeEach(() => {
  jest.clearAllMocks();
  setScenario();
});

const noQueriesRun = () => {
  expect(mockFeesAggregate).not.toHaveBeenCalled();
  expect(mockIncomeAggregate).not.toHaveBeenCalled();
  expect(mockExpenseAggregate).not.toHaveBeenCalled();
  expect(mockIncomeHeadFind).not.toHaveBeenCalled();
  expect(mockExpenseHeadFind).not.toHaveBeenCalled();
  expect(mockSalaryFind).not.toHaveBeenCalled();
};

describe("getFinanceReportService — validation (fail-closed)", () => {
  it.each([
    ["no params", {}],
    ["unknown mode", { mode: "weekly", date: "2026-11-12" }],
    ["daily missing date", { mode: "daily" }],
    ["daily bad calendar date", { mode: "daily", date: "2026-02-30" }],
    ["daily garbage date", { mode: "daily", date: "tomorrow" }],
    ["monthly missing month", { mode: "monthly" }],
    ["monthly month 13", { mode: "monthly", month: "2026-13" }],
    ["monthly month 00", { mode: "monthly", month: "2026-00" }],
    ["monthly unpadded", { mode: "monthly", month: "2026-1" }],
    ["monthly garbage", { mode: "monthly", month: "Nov-2026" }],
    ["yearly missing year", { mode: "yearly" }],
    ["yearly two digits", { mode: "yearly", year: "26" }],
    ["yearly garbage", { mode: "yearly", year: "abcd" }],
    ["yearly zero", { mode: "yearly", year: "0000" }],
  ])("%s → 400 and no query runs", async (_label, query) => {
    const res = mockRes();
    await getFinanceReportService(query, res);
    expect(res.status).toHaveBeenCalledWith(400);
    noQueriesRun();
  });
});

describe("range resolution — one shared LOCAL date path for all modes", () => {
  it("daily: from == to, bounds are [day midnight, next midnight)", async () => {
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const data = payload(res).data;
    expect(data.from).toBe("2026-11-12");
    expect(data.to).toBe("2026-11-12");

    const feeMatch = mockFeesAggregate.mock.calls[0][0][0].$match;
    expect(feeMatch.datePaid.$gte).toEqual(new Date(2026, 10, 12));
    expect(feeMatch.datePaid.$lt).toEqual(new Date(2026, 10, 13));
    expect(feeMatch.datePaid.$lte).toBeUndefined();

    const salaryMatch = mockSalaryFind.mock.calls[0][0];
    expect(salaryMatch.finalizedAt.$gte).toEqual(new Date(2026, 10, 12));
    expect(salaryMatch.finalizedAt.$lt).toEqual(new Date(2026, 10, 13));
  });

  it("monthly Nov: rolls up 2026-11-01 → 2026-11-30 (Dec 1 exclusive)", async () => {
    const res = mockRes();
    await getFinanceReportService({ mode: "monthly", month: "2026-11" }, res);
    const data = payload(res).data;
    expect(data.from).toBe("2026-11-01");
    expect(data.to).toBe("2026-11-30");
    const feeMatch = mockFeesAggregate.mock.calls[0][0][0].$match;
    expect(feeMatch.datePaid.$gte).toEqual(new Date(2026, 10, 1));
    expect(feeMatch.datePaid.$lt).toEqual(new Date(2026, 11, 1));
  });

  it("monthly Feb (non-leap): last day is the 28th", async () => {
    const res = mockRes();
    await getFinanceReportService({ mode: "monthly", month: "2026-02" }, res);
    expect(payload(res).data.to).toBe("2026-02-28");
    const feeMatch = mockFeesAggregate.mock.calls[0][0][0].$match;
    expect(feeMatch.datePaid.$lt).toEqual(new Date(2026, 2, 1));
  });

  it("monthly Feb (leap 2028): last day is the 29th", async () => {
    const res = mockRes();
    await getFinanceReportService({ mode: "monthly", month: "2028-02" }, res);
    expect(payload(res).data.to).toBe("2028-02-29");
    const feeMatch = mockFeesAggregate.mock.calls[0][0][0].$match;
    expect(feeMatch.datePaid.$lt).toEqual(new Date(2028, 2, 1));
  });

  it("monthly Dec: year rolls over at the exclusive upper bound", async () => {
    const res = mockRes();
    await getFinanceReportService({ mode: "monthly", month: "2026-12" }, res);
    expect(payload(res).data.to).toBe("2026-12-31");
    const feeMatch = mockFeesAggregate.mock.calls[0][0][0].$match;
    expect(feeMatch.datePaid.$lt).toEqual(new Date(2027, 0, 1));
  });

  it("yearly: 2026-01-01 → 2026-12-31 (Jan 1 2027 exclusive)", async () => {
    const res = mockRes();
    await getFinanceReportService({ mode: "yearly", year: "2026" }, res);
    const data = payload(res).data;
    expect(data.from).toBe("2026-01-01");
    expect(data.to).toBe("2026-12-31");
    const feeMatch = mockFeesAggregate.mock.calls[0][0][0].$match;
    expect(feeMatch.datePaid.$gte).toEqual(new Date(2026, 0, 1));
    expect(feeMatch.datePaid.$lt).toEqual(new Date(2027, 0, 1));
  });

  it("income/expense breakdowns use the SAME local bounds on date", async () => {
    const res = mockRes();
    await getFinanceReportService({ mode: "monthly", month: "2026-11" }, res);
    for (const mock of [mockIncomeAggregate, mockExpenseAggregate]) {
      // call 0 = core total, call 1 = head breakdown — both same range
      for (const call of mock.mock.calls) {
        const match = call[0][0].$match;
        expect(match.date.$gte).toEqual(new Date(2026, 10, 1));
        expect(match.date.$lt).toEqual(new Date(2026, 11, 1));
      }
    }
  });

  it("resolveReportRange is exported and pure (no queries)", () => {
    expect(resolveReportRange({ mode: "daily", date: "2026-11-12" })).toEqual({
      mode: "daily", from: "2026-11-12", to: "2026-11-12",
    });
    expect(resolveReportRange({ mode: "yearly", year: "2026" })).toEqual({
      mode: "yearly", from: "2026-01-01", to: "2026-12-31",
    });
    expect(resolveReportRange({ mode: "monthly", month: "2026-13" }).error).toBeTruthy();
    noQueriesRun();
  });
});

describe("salary query — finalized runs only, by finalize date", () => {
  it("matches status finalized + finalizedAt in the local range (drafts excluded)", async () => {
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    const match = mockSalaryFind.mock.calls[0][0];
    expect(match.status).toBe("finalized");
    expect(match.finalizedAt).toEqual({
      $gte: new Date(2026, 10, 12),
      $lt: new Date(2026, 10, 13),
    });
    expect(match.periodStart).toBeUndefined(); // follows the PAID date, not the pay period
  });
});

describe("net calculation — salaries folded in (Admin-confirmed)", () => {
  const run = (teacherId, name, netAmount) => ({
    _id: `run-${teacherId}-${netAmount}`,
    teacher: { _id: teacherId, name, teacherId: `T-${teacherId}` },
    periodStart: new Date(2026, 10, 1),
    periodEnd: new Date(2026, 10, 30),
    netAmount,
    finalizedAt: new Date(2026, 10, 12, 10, 0),
  });

  it("6000 + 1500 − 3000 − 2000 salaries = 2500; netBeforeSalaries = 4500", async () => {
    setScenario({
      fees: 6000, income: 1500, expenses: 3000,
      counts: { collections: 3, income: 2, expenses: 5 },
      runs: [run("a", "Teacher A", 1200), run("a", "Teacher A", 800)],
    });
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    const data = payload(res).data;
    expect(data).toMatchObject({
      collections: 6000, income: 1500, expenses: 3000,
      salaries: 2000, netBeforeSalaries: 4500, net: 2500,
    });
    expect(data.counts).toEqual({ collections: 3, income: 2, expenses: 5, salaries: 2 });
  });

  it("negative net is allowed (a loss): 1000 + 0 − 5000 − 0 = −4000", async () => {
    setScenario({ fees: 1000, expenses: 5000 });
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    expect(payload(res).data.net).toBe(-4000);
  });

  it("salaries alone can push a profitable day into a loss", async () => {
    setScenario({ fees: 1000, runs: [run("a", "Teacher A", 1500)] });
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    const data = payload(res).data;
    expect(data.netBeforeSalaries).toBe(1000);
    expect(data.net).toBe(-500);
  });

  it("rounds to 2 decimals (0.1 + 0.2 − 0 − 0.3 = 0, not 5e-17)", async () => {
    setScenario({ fees: 0.1, income: 0.2, runs: [run("a", "Teacher A", 0.3)] });
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    expect(payload(res).data.net).toBe(0);
  });

  it("empty period → all totals 0, empty breakdowns, counts 0", async () => {
    const res = mockRes();
    await getFinanceReportService({ mode: "monthly", month: "2026-01" }, res);
    const data = payload(res).data;
    expect(data).toMatchObject({ collections: 0, income: 0, expenses: 0, salaries: 0, net: 0, netBeforeSalaries: 0 });
    expect(data.counts).toEqual({ collections: 0, income: 0, expenses: 0, salaries: 0 });
    expect(data.incomeByHead).toEqual([]);
    expect(data.expensesByHead).toEqual([]);
    expect(data.salaryByTeacher).toEqual([]);
    expect(data.salaryRuns).toEqual([]);
    expect(mockIncomeHeadFind).not.toHaveBeenCalled(); // no groups → no name lookup
  });
});

describe("head breakdowns", () => {
  it("maps group totals to head names, keeps totals order, flags inactive heads", async () => {
    setScenario({
      income: 400,
      incomeGroups: [
        { _id: "h1", total: 300, count: 2 },
        { _id: "h2", total: 100, count: 1 },
      ],
      incomeHeads: [
        { _id: "h1", name: "Notes Sale", isActive: true },
        { _id: "h2", name: "Donations", isActive: false },
      ],
    });
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    const rows = payload(res).data.incomeByHead;
    expect(rows).toEqual([
      { headId: "h1", name: "Notes Sale", isActive: true, total: 300, count: 2 },
      { headId: "h2", name: "Donations", isActive: false, total: 100, count: 1 },
    ]);
    // ONE name lookup for all groups (no per-row find)
    expect(mockIncomeHeadFind).toHaveBeenCalledTimes(1);
    expect(mockIncomeHeadFind.mock.calls[0][0]).toEqual({ _id: { $in: ["h1", "h2"] } });
  });

  it("missing head doc / null head id fail soft to 'Unknown head'", async () => {
    setScenario({
      expenses: 150,
      expenseGroups: [
        { _id: "gone", total: 100, count: 1 },
        { _id: null, total: 50, count: 1 },
      ],
      expenseHeads: [],
    });
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    const rows = payload(res).data.expensesByHead;
    expect(rows[0]).toMatchObject({ headId: "gone", name: "Unknown head", total: 100 });
    expect(rows[1]).toMatchObject({ headId: null, name: "Unknown head", total: 50 });
  });

  it("breakdown totals reconcile with the headline income/expense totals", async () => {
    setScenario({
      income: 427.5,
      incomeGroups: [
        { _id: "h1", total: 400.25, count: 3 },
        { _id: "h2", total: 27.25, count: 1 },
      ],
      incomeHeads: [
        { _id: "h1", name: "A", isActive: true },
        { _id: "h2", name: "B", isActive: true },
      ],
    });
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    const data = payload(res).data;
    const sum = data.incomeByHead.reduce((s, h) => s + h.total, 0);
    expect(Math.round(sum * 100) / 100).toBe(data.income);
  });
});

describe("salary breakdown — per teacher + run audit trail", () => {
  const mkRun = (id, teacher, netAmount, finalizedAt) => ({
    _id: id,
    teacher,
    periodStart: new Date(2026, 9, 4),
    periodEnd: new Date(2026, 10, 3),
    netAmount,
    finalizedAt,
  });

  it("groups runs per teacher (netAmount sums), sorted by total desc", async () => {
    const a = { _id: "a", name: "Ayesha", teacherId: "T-01" };
    const b = { _id: "b", name: "Bilal", teacherId: "T-02" };
    setScenario({
      runs: [
        mkRun("r1", a, 1200, new Date(2026, 10, 12, 9)),
        mkRun("r2", b, 500, new Date(2026, 10, 12, 10)),
        mkRun("r3", a, 800, new Date(2026, 10, 12, 11)),
      ],
    });
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    const data = payload(res).data;
    expect(data.salaries).toBe(2500);
    expect(data.salaryByTeacher).toEqual([
      { teacherId: "a", name: "Ayesha", staffId: "T-01", runs: 2, total: 2000 },
      { teacherId: "b", name: "Bilal", staffId: "T-02", runs: 1, total: 500 },
    ]);
    expect(data.salaryRuns).toHaveLength(3);
    expect(data.salaryRuns[0]).toMatchObject({
      runId: "r1", teacherName: "Ayesha", netAmount: 1200,
    });
    expect(data.counts.salaries).toBe(3);
  });

  it("a deleted/missing teacher reference fails soft to 'Unknown teacher'", async () => {
    setScenario({ runs: [mkRun("r1", null, 900, new Date(2026, 10, 12))] });
    const res = mockRes();
    await getFinanceReportService({ mode: "daily", date: "2026-11-12" }, res);
    const data = payload(res).data;
    expect(data.salaries).toBe(900);
    expect(data.salaryByTeacher[0]).toMatchObject({ teacherId: null, name: "Unknown teacher", runs: 1, total: 900 });
    expect(data.salaryRuns[0].teacherName).toBe("Unknown teacher");
  });
});

describe("reporting envelope", () => {
  it("returns exactly the report envelope keys", async () => {
    setScenario({ fees: 100, income: 20, expenses: 30 });
    const res = mockRes();
    await getFinanceReportService({ mode: "yearly", year: "2026" }, res);
    expect(Object.keys(payload(res).data).sort()).toEqual(
      [
        "mode", "from", "to", "collections", "income", "expenses", "salaries",
        "netBeforeSalaries", "net", "counts",
        "incomeByHead", "expensesByHead", "salaryByTeacher", "salaryRuns",
      ].sort()
    );
  });
});
