/**
 * Income entry service tests (flexible ad-hoc income, parallel to Phase 3):
 * - Create fails closed BEFORE any write (bad/unknown/inactive head, bad date,
 *   empty description, ambiguous quantity/rate, invalid numbers).
 * - TWO modes: quantity + unitRate → totalAmount RECOMPUTED as round2(q × r)
 *   (client total ignored); neither → admin-entered totalAmount validated > 0.
 *   Giving only ONE of quantity/unitRate is rejected (ambiguous).
 * - History builds an INCLUSIVE local-calendar date range + head match, and the
 *   running total sums the FULL filtered set (aggregate), not just the page.
 *
 * Mirrors __tests__/expenseEntries.test.js. Models are mocked at the data layer
 * so the real service logic executes.
 */

const mockHeadFindById = jest.fn();
const mockEntryCreate = jest.fn();
const mockEntryFind = jest.fn();
const mockEntryCount = jest.fn();
const mockEntryAggregate = jest.fn();

jest.mock("../models/Income/incomeHead.model", () => ({
  findById: (...a) => mockHeadFindById(...a),
}));
jest.mock("../models/Income/incomeEntry.model", () => ({
  create: (...a) => mockEntryCreate(...a),
  find: (...a) => mockEntryFind(...a),
  countDocuments: (...a) => mockEntryCount(...a),
  aggregate: (...a) => mockEntryAggregate(...a),
}));

const mongoose = require("mongoose");
const {
  createIncomeEntryService,
  getIncomeEntriesService,
} = require("../services/income/incomeEntry.service");

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

const ACTIVE_HEAD = { _id: HEAD, name: "Notes Sale", isActive: true };
const qtyMode = {
  incomeHead: String(HEAD),
  date: "2026-11-15",
  description: "Notes sold to Grade 9",
  quantity: 2.5,
  unitRate: 45.5,
  notes: "batch 1",
};
const directMode = {
  incomeHead: String(HEAD),
  date: "2026-11-15",
  description: "Lump donation",
  quantity: "",
  unitRate: "",
  totalAmount: 5000,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockHeadFindById.mockReturnValue(headChain(ACTIVE_HEAD));
  mockEntryCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  mockEntryFind.mockReturnValue(findChain([]));
  mockEntryCount.mockResolvedValue(0);
  mockEntryAggregate.mockResolvedValue([]);
});

describe("createIncomeEntryService — validation (fail-closed)", () => {
  it.each([
    ["invalid head id", { ...qtyMode, incomeHead: "nope" }],
    ["bad calendar date", { ...qtyMode, date: "2026-02-30" }],
    ["empty description", { ...qtyMode, description: "   " }],
    ["zero quantity", { ...qtyMode, quantity: 0 }],
    ["negative quantity", { ...qtyMode, quantity: -1 }],
    ["non-numeric quantity", { ...qtyMode, quantity: "abc" }],
    ["negative rate", { ...qtyMode, unitRate: -5 }],
    ["non-numeric rate", { ...qtyMode, unitRate: "abc" }],
    ["quantity without rate (ambiguous)", { ...qtyMode, unitRate: "" }],
    ["rate without quantity (ambiguous)", { ...qtyMode, quantity: "" }],
    ["direct total zero", { ...directMode, totalAmount: 0 }],
    ["direct total negative", { ...directMode, totalAmount: -100 }],
    ["direct total non-numeric", { ...directMode, totalAmount: "abc" }],
    ["direct total missing", { ...directMode, totalAmount: "" }],
  ])("%s → 400 and nothing written", async (_label, body) => {
    const res = mockRes();
    await createIncomeEntryService(body, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryCreate).not.toHaveBeenCalled();
  });

  it("unknown head → 400 and nothing written", async () => {
    mockHeadFindById.mockReturnValue(headChain(null));
    const res = mockRes();
    await createIncomeEntryService(qtyMode, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryCreate).not.toHaveBeenCalled();
  });

  it("inactive head → 400 and nothing written (must reactivate first)", async () => {
    mockHeadFindById.mockReturnValue(headChain({ _id: HEAD, name: "Notes Sale", isActive: false }));
    const res = mockRes();
    await createIncomeEntryService(qtyMode, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryCreate).not.toHaveBeenCalled();
  });
});

describe("createIncomeEntryService — quantity mode (server-computed total)", () => {
  it("decimals: 2.5 × 45.50 = 113.75, stored at local midnight with the admin id", async () => {
    const res = mockRes();
    await createIncomeEntryService(qtyMode, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEntryCreate).toHaveBeenCalledTimes(1);
    const doc = mockEntryCreate.mock.calls[0][0];
    expect(doc).toMatchObject({
      description: "Notes sold to Grade 9",
      quantity: 2.5,
      unitRate: 45.5,
      totalAmount: 113.75,
      notes: "batch 1",
      createdBy: ADMIN,
    });
    expect(String(doc.incomeHead)).toBe(String(HEAD));
    expect(doc.date.getDate()).toBe(15);
    expect(doc.date.getMonth()).toBe(10); // November
    expect(doc.date.getHours()).toBe(0);
  });

  it("ignores a client-supplied totalAmount and recomputes it", async () => {
    const res = mockRes();
    await createIncomeEntryService({ ...qtyMode, totalAmount: 999999 }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEntryCreate.mock.calls[0][0].totalAmount).toBe(113.75);
  });

  it("rounds to 2 decimals: 2 × 33.333 = 66.67", async () => {
    const res = mockRes();
    await createIncomeEntryService({ ...qtyMode, quantity: 2, unitRate: 33.333 }, ADMIN, res);
    expect(mockEntryCreate.mock.calls[0][0].totalAmount).toBe(66.67);
  });

  it("allows a zero unit rate → total 0", async () => {
    const res = mockRes();
    await createIncomeEntryService({ ...qtyMode, quantity: 3, unitRate: 0 }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockEntryCreate.mock.calls[0][0].totalAmount).toBe(0);
  });
});

describe("createIncomeEntryService — direct mode (admin-entered total)", () => {
  it("stores the entered total and omits quantity/unitRate", async () => {
    const res = mockRes();
    await createIncomeEntryService(directMode, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const doc = mockEntryCreate.mock.calls[0][0];
    expect(doc.totalAmount).toBe(5000);
    expect(doc.quantity).toBeUndefined();
    expect(doc.unitRate).toBeUndefined();
    expect(doc.description).toBe("Lump donation");
    expect(doc.createdBy).toBe(ADMIN);
  });

  it("normalises the entered total with round2 (5000.555 → 5000.56)", async () => {
    const res = mockRes();
    await createIncomeEntryService({ ...directMode, totalAmount: 5000.555 }, ADMIN, res);
    expect(mockEntryCreate.mock.calls[0][0].totalAmount).toBe(5000.56);
  });

  it("treats omitted quantity/unitRate (undefined) as direct mode", async () => {
    const res = mockRes();
    const body = { incomeHead: String(HEAD), date: "2026-11-15", description: "Donation", totalAmount: 250 };
    await createIncomeEntryService(body, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const doc = mockEntryCreate.mock.calls[0][0];
    expect(doc.totalAmount).toBe(250);
    expect(doc.quantity).toBeUndefined();
  });
});

describe("getIncomeEntriesService — history filters", () => {
  it("builds an INCLUSIVE local-calendar range: [from midnight, to midnight + 1 day)", async () => {
    const res = mockRes();
    await getIncomeEntriesService({ from: "2026-11-01", to: "2026-11-30" }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const filter = mockEntryFind.mock.calls[0][0];
    expect(filter.date.$gte).toEqual(new Date(2026, 10, 1)); // Nov 1 00:00 local
    expect(filter.date.$lt).toEqual(new Date(2026, 11, 1)); // Dec 1 00:00 local
    // The aggregate uses the SAME match as the page query.
    expect(mockEntryAggregate.mock.calls[0][0][0].$match).toEqual(filter);
  });

  it("casts the head filter to an ObjectId for the aggregate $match", async () => {
    const res = mockRes();
    await getIncomeEntriesService({ incomeHead: String(HEAD) }, res);
    const filter = mockEntryFind.mock.calls[0][0];
    expect(filter.incomeHead).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(filter.incomeHead)).toBe(String(HEAD));
  });

  it("sorts newest-first and populates head + creator", async () => {
    const chain = findChain([]);
    mockEntryFind.mockReturnValue(chain);
    const res = mockRes();
    await getIncomeEntriesService({}, res);
    expect(chain.sort).toHaveBeenCalledWith("-date -createdAt");
    expect(chain.populate).toHaveBeenCalledTimes(2);
  });

  it("invalid head filter → 400", async () => {
    const res = mockRes();
    await getIncomeEntriesService({ incomeHead: "nope" }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryFind).not.toHaveBeenCalled();
  });

  it("from after to → 400", async () => {
    const res = mockRes();
    await getIncomeEntriesService({ from: "2026-12-01", to: "2026-11-01" }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryFind).not.toHaveBeenCalled();
  });

  it("bad from date → 400", async () => {
    const res = mockRes();
    await getIncomeEntriesService({ from: "2026-02-30" }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryFind).not.toHaveBeenCalled();
  });
});

describe("getIncomeEntriesService — running total over the FULL filtered set", () => {
  it("sums every matching entry (aggregate), independent of the current page", async () => {
    const row = { _id: new mongoose.Types.ObjectId(), totalAmount: 113.75 };
    mockEntryFind.mockReturnValue(findChain([row])); // page shows just 1 row
    mockEntryCount.mockResolvedValue(50);
    mockEntryAggregate.mockResolvedValue([{ _id: null, total: 5000, count: 50 }]);

    const res = mockRes();
    await getIncomeEntriesService({ page: 1, limit: 1 }, res);
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
    await getIncomeEntriesService({}, res);
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
    await getIncomeEntriesService({ page: 2, limit: 10 }, res);
    const data = payload(res).data;
    expect(data.pagination).toMatchObject({ total: 25, page: 2, limit: 10, pages: 3, hasPrev: true, hasNext: true });
    expect(data.runningTotal).toBe(1234.5);
  });
});