/**
 * Expense entry service tests (Phase 3):
 * - Create fails closed BEFORE any write (bad/unknown/inactive head, bad date,
 *   empty item, quantity <= 0 / non-numeric, rate < 0 / non-numeric).
 * - totalAmount is RECOMPUTED server-side as round2(quantity × unitRate); a
 *   client-supplied total is never trusted. Decimals are supported.
 * - History builds an INCLUSIVE local-calendar date range + head match, and the
 *   running total sums the FULL filtered set (aggregate), not just the page.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockHeadFindById = jest.fn();
const mockEntryCreate = jest.fn();
const mockEntryFind = jest.fn();
const mockEntryCount = jest.fn();
const mockEntryAggregate = jest.fn();

jest.mock("../models/Expenses/expenseHead.model", () => ({
  findById: (...a) => mockHeadFindById(...a),
}));
jest.mock("../models/Expenses/expenseEntry.model", () => ({
  create: (...a) => mockEntryCreate(...a),
  find: (...a) => mockEntryFind(...a),
  countDocuments: (...a) => mockEntryCount(...a),
  aggregate: (...a) => mockEntryAggregate(...a),
}));

const mongoose = require("mongoose");
const {
  createExpenseEntryService,
  getExpenseEntriesService,
} = require("../services/expenses/expenseEntry.service");

const ADMIN = new mongoose.Types.ObjectId();
const HEAD = new mongoose.Types.ObjectId();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];

// findById(...).select("name isActive").lean()
const headChain = (doc) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(doc),
});
// paginate: find(...).skip().limit().sort().populate().populate().lean()
const findChain = (docs) => ({
  skip: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  populate: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(docs),
});

const ACTIVE_HEAD = { _id: HEAD, name: "Printing", isActive: true };
const valid = {
  expenseHead: String(HEAD),
  date: "2026-11-15",
  itemName: "A4 paper ream",
  quantity: 2.5,
  unitRate: 45.5,
  notes: "ream",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockHeadFindById.mockReturnValue(headChain(ACTIVE_HEAD));
  mockEntryCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  mockEntryFind.mockReturnValue(findChain([]));
  mockEntryCount.mockResolvedValue(0);
  mockEntryAggregate.mockResolvedValue([]);
});

describe("createExpenseEntryService — validation (fail-closed)", () => {
  it.each([
    ["invalid head id", { ...valid, expenseHead: "nope" }],
    ["bad calendar date", { ...valid, date: "2026-02-30" }],
    ["empty item name", { ...valid, itemName: "   " }],
    ["zero quantity", { ...valid, quantity: 0 }],
    ["negative quantity", { ...valid, quantity: -1 }],
    ["non-numeric quantity", { ...valid, quantity: "abc" }],
    ["negative rate", { ...valid, unitRate: -5 }],
    ["non-numeric rate", { ...valid, unitRate: "abc" }],
  ])("%s → 400 and nothing written", async (_label, body) => {
    const res = mockRes();
    await createExpenseEntryService(body, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryCreate).not.toHaveBeenCalled();
  });

  it("unknown head → 400 and nothing written", async () => {
    mockHeadFindById.mockReturnValue(headChain(null));
    const res = mockRes();
    await createExpenseEntryService(valid, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryCreate).not.toHaveBeenCalled();
  });

  it("inactive head → 400 and nothing written (must reactivate first)", async () => {
    mockHeadFindById.mockReturnValue(headChain({ _id: HEAD, name: "Printing", isActive: false }));
    const res = mockRes();
    await createExpenseEntryService(valid, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryCreate).not.toHaveBeenCalled();
  });
});

describe("createExpenseEntryService — server-computed total", () => {
  it("decimals: 2.5 × 45.50 = 113.75, stored at local midnight with the admin id", async () => {
    const res = mockRes();
    await createExpenseEntryService(valid, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEntryCreate).toHaveBeenCalledTimes(1);
    const doc = mockEntryCreate.mock.calls[0][0];
    expect(doc).toMatchObject({
      itemName: "A4 paper ream",
      quantity: 2.5,
      unitRate: 45.5,
      totalAmount: 113.75,
      notes: "ream",
      createdBy: ADMIN,
    });
    expect(String(doc.expenseHead)).toBe(String(HEAD));
    expect(doc.date.getDate()).toBe(15);
    expect(doc.date.getMonth()).toBe(10); // November
    expect(doc.date.getHours()).toBe(0);
  });

  it("ignores a client-supplied totalAmount and recomputes it", async () => {
    const res = mockRes();
    await createExpenseEntryService({ ...valid, totalAmount: 999999 }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEntryCreate.mock.calls[0][0].totalAmount).toBe(113.75);
  });

  it("rounds to 2 decimals: 2 × 33.333 = 66.67", async () => {
    const res = mockRes();
    await createExpenseEntryService({ ...valid, quantity: 2, unitRate: 33.333 }, ADMIN, res);
    expect(mockEntryCreate.mock.calls[0][0].totalAmount).toBe(66.67);
  });

  it("allows a zero unit rate (free item) → total 0", async () => {
    const res = mockRes();
    await createExpenseEntryService({ ...valid, quantity: 3, unitRate: 0 }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEntryCreate.mock.calls[0][0].totalAmount).toBe(0);
  });
});

describe("getExpenseEntriesService — history filters", () => {
  it("builds an INCLUSIVE local-calendar range: [from midnight, to midnight + 1 day)", async () => {
    const res = mockRes();
    await getExpenseEntriesService({ from: "2026-11-01", to: "2026-11-30" }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const filter = mockEntryFind.mock.calls[0][0];
    expect(filter.date.$gte).toEqual(new Date(2026, 10, 1)); // Nov 1 00:00 local
    expect(filter.date.$lt).toEqual(new Date(2026, 11, 1)); // Dec 1 00:00 local
    // The aggregate uses the SAME match as the page query.
    expect(mockEntryAggregate.mock.calls[0][0][0].$match).toEqual(filter);
  });

  it("casts the head filter to an ObjectId for the aggregate $match", async () => {
    const res = mockRes();
    await getExpenseEntriesService({ expenseHead: String(HEAD) }, res);
    const filter = mockEntryFind.mock.calls[0][0];
    expect(filter.expenseHead).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(filter.expenseHead)).toBe(String(HEAD));
  });

  it("sorts newest-first and populates head + creator", async () => {
    const chain = findChain([]);
    mockEntryFind.mockReturnValue(chain);
    const res = mockRes();
    await getExpenseEntriesService({}, res);
    expect(chain.sort).toHaveBeenCalledWith("-date -createdAt");
    expect(chain.populate).toHaveBeenCalledTimes(2);
  });

  it("invalid head filter → 400", async () => {
    const res = mockRes();
    await getExpenseEntriesService({ expenseHead: "nope" }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryFind).not.toHaveBeenCalled();
  });

  it("from after to → 400", async () => {
    const res = mockRes();
    await getExpenseEntriesService({ from: "2026-12-01", to: "2026-11-01" }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryFind).not.toHaveBeenCalled();
  });

  it("bad from date → 400", async () => {
    const res = mockRes();
    await getExpenseEntriesService({ from: "2026-02-30" }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryFind).not.toHaveBeenCalled();
  });
});

describe("getExpenseEntriesService — running total over the FULL filtered set", () => {
  it("sums every matching entry (aggregate), independent of the current page", async () => {
    const row = { _id: new mongoose.Types.ObjectId(), totalAmount: 113.75 };
    mockEntryFind.mockReturnValue(findChain([row])); // page shows just 1 row
    mockEntryCount.mockResolvedValue(50);
    mockEntryAggregate.mockResolvedValue([{ _id: null, total: 5000, count: 50 }]);

    const res = mockRes();
    await getExpenseEntriesService({ page: 1, limit: 1 }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const data = payload(res).data;
    expect(data.entries).toHaveLength(1);
    expect(data.runningTotal).toBe(5000); // NOT 113.75 (the page sum)
    expect(data.count).toBe(50);
    expect(data.pagination.total).toBe(50);
  });

  it("no matches → runningTotal 0 and count 0", async () => {
    mockEntryAggregate.mockResolvedValue([]);
    const res = mockRes();
    await getExpenseEntriesService({}, res);
    const data = payload(res).data;
    expect(data.runningTotal).toBe(0);
    expect(data.count).toBe(0);
    expect(data.entries).toHaveLength(0);
  });

  it("returns the pagination envelope (page 2 of a larger set)", async () => {
    mockEntryFind.mockReturnValue(findChain([{ _id: new mongoose.Types.ObjectId() }]));
    mockEntryCount.mockResolvedValue(25);
    mockEntryAggregate.mockResolvedValue([{ _id: null, total: 1234.5, count: 25 }]);
    const res = mockRes();
    await getExpenseEntriesService({ page: 2, limit: 10 }, res);
    const data = payload(res).data;
    expect(data.pagination).toMatchObject({ total: 25, page: 2, limit: 10, pages: 3, hasPrev: true, hasNext: true });
    expect(data.runningTotal).toBe(1234.5);
  });
});