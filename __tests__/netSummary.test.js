/**
 * Net profit/loss building-block tests (finance net-summary):
 * - Fail-closed validation: both from AND to required, valid YYYY-MM-DD,
 *   from <= to — otherwise 400 and NO aggregate runs.
 * - Collections mirrors getDailyCollectionData's effective query: paid fees,
 *   datePaid in the inclusive LOCAL range, soft-deleted excluded. Income and
 *   expenses sum totalAmount over the same local range on `date`.
 * - Net = collections + income − expenses (round2), negative net allowed (loss).
 * - The three totals are fetched in parallel; counts + envelope returned.
 *
 * Models are mocked at the data layer; utils/dateRange runs for real so the
 * inclusive local-midnight bounds are asserted exactly.
 */

const mockFeesAggregate = jest.fn();
const mockIncomeAggregate = jest.fn();
const mockExpenseAggregate = jest.fn();

jest.mock("../models/Fees/fees.model", () => ({
  aggregate: (...a) => mockFeesAggregate(...a),
}));
jest.mock("../models/Income/incomeEntry.model", () => ({
  aggregate: (...a) => mockIncomeAggregate(...a),
}));
jest.mock("../models/Expenses/expenseEntry.model", () => ({
  aggregate: (...a) => mockExpenseAggregate(...a),
}));

const { getNetSummaryService } = require("../services/finance/netSummary.service");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];

const agg = (total, count) => [{ _id: null, total, count }];
function setTotals(fees, income, expenses, counts = {}) {
  mockFeesAggregate.mockResolvedValue(agg(fees, counts.collections || 0));
  mockIncomeAggregate.mockResolvedValue(agg(income, counts.income || 0));
  mockExpenseAggregate.mockResolvedValue(agg(expenses, counts.expenses || 0));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFeesAggregate.mockResolvedValue([]);
  mockIncomeAggregate.mockResolvedValue([]);
  mockExpenseAggregate.mockResolvedValue([]);
});

describe("getNetSummaryService — validation (fail-closed)", () => {
  it.each([
    ["no params", {}],
    ["missing to", { from: "2026-11-01" }],
    ["missing from", { to: "2026-11-30" }],
    ["bad from", { from: "2026-02-30", to: "2026-11-30" }],
    ["bad to", { from: "2026-11-01", to: "2026-13-01" }],
    ["from after to", { from: "2026-12-01", to: "2026-11-01" }],
  ])("%s → 400 and no aggregate runs", async (_label, query) => {
    const res = mockRes();
    await getNetSummaryService(query, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockFeesAggregate).not.toHaveBeenCalled();
    expect(mockIncomeAggregate).not.toHaveBeenCalled();
    expect(mockExpenseAggregate).not.toHaveBeenCalled();
  });
});

describe("getNetSummaryService — query shape (inclusive local range)", () => {
  it("collections = paid + not-deleted + datePaid in [from midnight, to midnight + 1 day)", async () => {
    const res = mockRes();
    await getNetSummaryService({ from: "2026-11-01", to: "2026-11-30" }, res);
    expect(res.status).toHaveBeenCalledWith(200);

    const feePipeline = mockFeesAggregate.mock.calls[0][0];
    const feeMatch = feePipeline[0].$match;
    expect(feeMatch.status).toBe("paid");
    expect(feeMatch.isDeleted).toEqual({ $ne: true });
    expect(feeMatch.datePaid.$gte).toEqual(new Date(2026, 10, 1)); // Nov 1 00:00 local
    expect(feeMatch.datePaid.$lt).toEqual(new Date(2026, 11, 1)); // Dec 1 00:00 local
    expect(feeMatch.datePaid.$lte).toBeUndefined(); // never an inclusive UTC $lte
    expect(feePipeline[1].$group.total).toEqual({ $sum: "$amount" });
  });

  it("income + expenses sum totalAmount over the SAME local range on date", async () => {
    const res = mockRes();
    await getNetSummaryService({ from: "2026-11-01", to: "2026-11-30" }, res);

    for (const mock of [mockIncomeAggregate, mockExpenseAggregate]) {
      const pipeline = mock.mock.calls[0][0];
      expect(pipeline[0].$match.date.$gte).toEqual(new Date(2026, 10, 1));
      expect(pipeline[0].$match.date.$lt).toEqual(new Date(2026, 11, 1));
      expect(pipeline[1].$group.total).toEqual({ $sum: "$totalAmount" });
    }
  });

  it("from == to covers exactly that one local day", async () => {
    const res = mockRes();
    await getNetSummaryService({ from: "2026-11-30", to: "2026-11-30" }, res);
    const feeMatch = mockFeesAggregate.mock.calls[0][0][0].$match;
    expect(feeMatch.datePaid.$gte).toEqual(new Date(2026, 10, 30));
    expect(feeMatch.datePaid.$lt).toEqual(new Date(2026, 11, 1));
  });
});

describe("getNetSummaryService — net calculation", () => {
  it("net = collections + income − expenses (6000 + 1500 − 3000 = 4500)", async () => {
    setTotals(6000, 1500, 3000, { collections: 3, income: 2, expenses: 5 });
    const res = mockRes();
    await getNetSummaryService({ from: "2026-11-01", to: "2026-11-30" }, res);
    const data = payload(res).data;
    expect(data).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-30",
      collections: 6000,
      income: 1500,
      expenses: 3000,
      net: 4500,
    });
    expect(data.counts).toEqual({ collections: 3, income: 2, expenses: 5 });
  });

  it("negative net is allowed (a loss): 1000 + 0 − 5000 = −4000", async () => {
    setTotals(1000, 0, 5000);
    const res = mockRes();
    await getNetSummaryService({ from: "2026-11-01", to: "2026-11-30" }, res);
    expect(payload(res).data.net).toBe(-4000);
  });

  it("rounds the net to 2 decimals (0.1 + 0.2 − 0 = 0.3, not 0.30000000000000004)", async () => {
    setTotals(0.1, 0.2, 0);
    const res = mockRes();
    await getNetSummaryService({ from: "2026-11-01", to: "2026-11-30" }, res);
    expect(payload(res).data.net).toBe(0.3);
  });

  it("no matching rows → all totals 0, net 0, counts 0", async () => {
    const res = mockRes();
    await getNetSummaryService({ from: "2026-11-01", to: "2026-11-30" }, res);
    const data = payload(res).data;
    expect(data).toMatchObject({ collections: 0, income: 0, expenses: 0, net: 0 });
    expect(data.counts).toEqual({ collections: 0, income: 0, expenses: 0 });
  });

  it("returns exactly the reporting envelope keys", async () => {
    setTotals(100, 20, 30);
    const res = mockRes();
    await getNetSummaryService({ from: "2026-11-01", to: "2026-11-30" }, res);
    expect(Object.keys(payload(res).data).sort()).toEqual(
      ["collections", "counts", "expenses", "from", "income", "net", "to"].sort()
    );
  });
});