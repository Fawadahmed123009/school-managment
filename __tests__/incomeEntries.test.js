/**
 * Income entry service tests (flexible ad-hoc income, parallel to Phase 3):
 * - Create fails closed BEFORE any write (bad/unknown/inactive head, bad date,
 *   empty description, ambiguous quantity/rate, invalid numbers).
 * - TWO modes: quantity + unitRate → totalAmount RECOMPUTED as round2(q × r)
 *   (client total ignored); neither → admin-entered totalAmount validated > 0.
 *   Giving only ONE of quantity/unitRate is rejected (ambiguous).
 * - History builds an INCLUSIVE local-calendar date range + head match, and the
 *   running total sums the FULL filtered set (aggregate), not just the page.
 * - Edit (ALL fields) follows the same rules as create, recomputing the total in
 *   quantity mode and honouring a manual total in direct mode, auditing only the
 *   changed fields.
 * - Delete is SOFT: the row is flagged isDeleted/deletedAt/deletedBy, a full
 *   snapshot goes to the audit trail, and no hard-delete path is ever reached —
 *   including the schema-level scoping + hard-delete guards on the real model.
 *
 * Mirrors __tests__/expenseEntries.test.js. Models are mocked at the data layer
 * so the real service logic executes.
 */

const mockHeadFindById = jest.fn();
const mockEntryCreate = jest.fn();
const mockEntryFind = jest.fn();
const mockEntryCount = jest.fn();
const mockEntryAggregate = jest.fn();
const mockEntryFindById = jest.fn();
const mockEntryFindByIdAndUpdate = jest.fn();
const mockEntryFindOneAndUpdate = jest.fn();
// Every hard-delete entry point must stay UNCALLED — asserted below.
const mockEntryDeleteOne = jest.fn();
const mockEntryDeleteMany = jest.fn();
const mockEntryFindByIdAndDelete = jest.fn();

// The real recorder is fail-open and skips without a DB connection, so it is
// mocked here to assert WHAT each hook records (keeping formatMoney/formatDay/
// changedFields real). Same pattern as __tests__/auditLogFinanceHooks.test.js.
jest.mock("../services/audit/auditLog.service", () => {
  const actual = jest.requireActual("../services/audit/auditLog.service");
  return { ...actual, recordAudit: jest.fn() };
});

jest.mock("../models/Income/incomeHead.model", () => ({
  findById: (...a) => mockHeadFindById(...a),
}));
jest.mock("../models/Income/incomeEntry.model", () => ({
  create: (...a) => mockEntryCreate(...a),
  find: (...a) => mockEntryFind(...a),
  countDocuments: (...a) => mockEntryCount(...a),
  aggregate: (...a) => mockEntryAggregate(...a),
  findById: (...a) => mockEntryFindById(...a),
  findByIdAndUpdate: (...a) => mockEntryFindByIdAndUpdate(...a),
  findOneAndUpdate: (...a) => mockEntryFindOneAndUpdate(...a),
  deleteOne: (...a) => mockEntryDeleteOne(...a),
  deleteMany: (...a) => mockEntryDeleteMany(...a),
  findByIdAndDelete: (...a) => mockEntryFindByIdAndDelete(...a),
}));

// The real (unmocked) model, so the schema-level soft-delete guards can be
// exercised without a database connection.
const RealIncomeEntry = jest.requireActual("../models/Income/incomeEntry.model");

const mongoose = require("mongoose");
const { recordAudit } = require("../services/audit/auditLog.service");
const {
  createIncomeEntryService,
  getIncomeEntriesService,
  updateIncomeEntryService,
  deleteIncomeEntryService,
} = require("../services/income/incomeEntry.service");

const ADMIN = new mongoose.Types.ObjectId();
const HEAD = new mongoose.Types.ObjectId();
const ENTRY = new mongoose.Types.ObjectId();

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
// findById(id).populate("incomeHead", "name").lean() — the edit/delete pre-read.
const preImageChain = (doc) => ({
  populate: jest.fn().mockReturnThis(),
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
  // Default: the row does not exist (a soft-deleted row is invisible to
  // findById, so an unstubbed edit/delete must 404 rather than throw).
  mockEntryFindById.mockReturnValue(preImageChain(null));
  mockEntryFindByIdAndUpdate.mockResolvedValue(null);
  mockEntryFindOneAndUpdate.mockResolvedValue(null);
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

// ═════════════════════════════════════════════════════════════════════════════
//  Edit + soft delete (admin only) — the Fees pattern applied to income
// ═════════════════════════════════════════════════════════════════════════════

/** A stored quantity-mode entry, exactly as findById().populate().lean() returns it. */
function storedEntry(overrides = {}) {
  return {
    _id: ENTRY,
    incomeHead: { _id: HEAD, name: "Notes Sale" },
    date: new Date(2026, 10, 15),
    description: "Notes sold to Grade 9",
    quantity: 2.5,
    unitRate: 45.5,
    totalAmount: 113.75,
    notes: "batch 1",
    isDeleted: false,
    ...overrides,
  };
}

const EDIT_BASE = {
  incomeHead: String(HEAD),
  date: "2026-11-20",
  description: "Notes sold to Grade 9",
  notes: "batch 2",
};

describe("updateIncomeEntryService — validation (fail-closed)", () => {
  it("invalid entry id → 400 and nothing written", async () => {
    const res = mockRes();
    await updateIncomeEntryService("nope", { ...EDIT_BASE, quantity: 4, unitRate: 50 }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("unknown (or already soft-deleted) entry → 404 and nothing written", async () => {
    mockEntryFindById.mockReturnValue(preImageChain(null));
    const res = mockRes();
    await updateIncomeEntryService(String(ENTRY), { ...EDIT_BASE, quantity: 4, unitRate: 50 }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockEntryFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("inactive head → 400 and nothing written", async () => {
    mockEntryFindById.mockReturnValue(preImageChain(storedEntry()));
    mockHeadFindById.mockImplementation((id) =>
      headChain(String(id) === String(HEAD) ? { _id: HEAD, name: "Notes Sale", isActive: false } : ACTIVE_HEAD)
    );
    const res = mockRes();
    await updateIncomeEntryService(String(ENTRY), { ...EDIT_BASE, quantity: 4, unitRate: 50 }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["bad calendar date", { ...EDIT_BASE, date: "2026-02-30", quantity: 4, unitRate: 50 }],
    ["empty description", { ...EDIT_BASE, description: "   ", quantity: 4, unitRate: 50 }],
    ["zero quantity", { ...EDIT_BASE, quantity: 0, unitRate: 50 }],
    ["negative unit rate", { ...EDIT_BASE, quantity: 4, unitRate: -5 }],
    ["quantity without rate (ambiguous)", { ...EDIT_BASE, quantity: 4, unitRate: "" }],
    ["rate without quantity (ambiguous)", { ...EDIT_BASE, quantity: "", unitRate: 50 }],
    ["direct total zero", { ...EDIT_BASE, quantity: "", unitRate: "", totalAmount: 0 }],
    ["direct total non-numeric", { ...EDIT_BASE, quantity: "", unitRate: "", totalAmount: "abc" }],
    ["no amount information at all", { ...EDIT_BASE, quantity: "", unitRate: "", totalAmount: "" }],
  ])("%s → 400 and nothing written", async (_label, body) => {
    mockEntryFindById.mockReturnValue(preImageChain(storedEntry()));
    const res = mockRes();
    await updateIncomeEntryService(String(ENTRY), body, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockEntryFindByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe("updateIncomeEntryService — every field is editable", () => {
  it("quantity mode recomputes the total and ignores the submitted one", async () => {
    mockEntryFindById.mockReturnValue(preImageChain(storedEntry()));
    mockEntryFindByIdAndUpdate.mockResolvedValue(storedEntry({ totalAmount: 200 }));
    const res = mockRes();
    await updateIncomeEntryService(
      String(ENTRY),
      { ...EDIT_BASE, quantity: 4, unitRate: 50, totalAmount: 999999 },
      ADMIN,
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const update = mockEntryFindByIdAndUpdate.mock.calls[0][1].$set;
    expect(update.totalAmount).toBe(200); // 4 × 50, not 999999
    expect(update.quantity).toBe(4);
    expect(update.unitRate).toBe(50);
    expect(update.date).toEqual(new Date(2026, 10, 20)); // local midnight, new day
    expect(update.description).toBe("Notes sold to Grade 9");
    expect(update.notes).toBe("batch 2");
    expect(update.incomeHead).toEqual(HEAD);
  });

  it("a manual total is honoured (direct mode) and quantity/unitRate are unset", async () => {
    mockEntryFindById.mockReturnValue(preImageChain(storedEntry()));
    mockEntryFindByIdAndUpdate.mockResolvedValue(storedEntry({ quantity: undefined, unitRate: undefined, totalAmount: 5000 }));
    const res = mockRes();
    await updateIncomeEntryService(
      String(ENTRY),
      { ...EDIT_BASE, quantity: "", unitRate: "", totalAmount: 5000 },
      ADMIN,
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const call = mockEntryFindByIdAndUpdate.mock.calls[0][1];
    expect(call.$set.totalAmount).toBe(5000);
    // Switching modes must not leave the old units behind.
    expect(Object.keys(call.$unset)).toEqual(expect.arrayContaining(["quantity", "unitRate"]));
  });

  it("rounds a manual total with round2 (5000.555 → 5000.56)", async () => {
    mockEntryFindById.mockReturnValue(preImageChain(storedEntry()));
    mockEntryFindByIdAndUpdate.mockResolvedValue(storedEntry());
    const res = mockRes();
    await updateIncomeEntryService(
      String(ENTRY),
      { ...EDIT_BASE, quantity: "", unitRate: "", totalAmount: 5000.555 },
      ADMIN,
      res
    );
    expect(mockEntryFindByIdAndUpdate.mock.calls[0][1].$set.totalAmount).toBe(5000.56);
  });
});

describe("updateIncomeEntryService — audit trail", () => {
  it("records an update naming who edited it, with only the changed fields", async () => {
    mockEntryFindById.mockReturnValue(preImageChain(storedEntry()));
    mockEntryFindByIdAndUpdate.mockResolvedValue(storedEntry({ totalAmount: 200, quantity: 4, unitRate: 50 }));
    const res = mockRes();
    await updateIncomeEntryService(String(ENTRY), { ...EDIT_BASE, quantity: 4, unitRate: 50 }, ADMIN, res);

    expect(recordAudit).toHaveBeenCalledTimes(1);
    const entry = recordAudit.mock.calls[0][0];
    expect(entry).toMatchObject({
      userId: ADMIN,
      actionType: "update",
      entityType: "income_entry",
      entityId: ENTRY,
    });
    expect(entry.summary).toContain("Edited income");
    // Untouched fields (head, description) stay out of the diff; the changed
    // ones are recorded before → after.
    expect(entry.beforeSnapshot.quantity).toBe(2.5);
    expect(entry.afterSnapshot.quantity).toBe(4);
    expect(entry.beforeSnapshot.totalAmount).toBe(113.75);
    expect(entry.afterSnapshot.totalAmount).toBe(200);
    // Description and head are unchanged → absent; the moved date is recorded.
    expect(entry.beforeSnapshot.description).toBeUndefined();
    expect(entry.beforeSnapshot.incomeHead).toBeUndefined();
    expect(entry.beforeSnapshot.date).toEqual(new Date(2026, 10, 15));
    expect(entry.afterSnapshot.date).toEqual(new Date(2026, 10, 20));
  });

  it("records nothing when the edit changes no field", async () => {
    const before = storedEntry();
    mockEntryFindById.mockReturnValue(preImageChain(before));
    mockEntryFindByIdAndUpdate.mockResolvedValue(before);
    const res = mockRes();
    await updateIncomeEntryService(
      String(ENTRY),
      {
        incomeHead: String(HEAD),
        date: "2026-11-15",
        description: "Notes sold to Grade 9",
        quantity: 2.5,
        unitRate: 45.5,
        totalAmount: 113.75,
        notes: "batch 1",
      },
      ADMIN,
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("deleteIncomeEntryService — soft delete only, always attributed", () => {
  it("flags isDeleted with deletedAt/deletedBy and never hard-deletes", async () => {
    mockEntryFindById.mockReturnValue(preImageChain(storedEntry()));
    mockEntryFindOneAndUpdate.mockResolvedValue(storedEntry({ isDeleted: true }));
    const res = mockRes();
    await deleteIncomeEntryService(String(ENTRY), ADMIN, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockEntryFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = mockEntryFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: String(ENTRY) });
    expect(update.isDeleted).toBe(true);
    expect(update.deletedBy).toEqual(ADMIN);
    expect(update.deletedAt).toBeInstanceOf(Date);
    expect(options).toMatchObject({ new: true });

    // No hard-removal path is reachable from this service.
    expect(mockEntryDeleteOne).not.toHaveBeenCalled();
    expect(mockEntryDeleteMany).not.toHaveBeenCalled();
    expect(mockEntryFindByIdAndDelete).not.toHaveBeenCalled();
  });

  it("audits the deletion with a full snapshot of what was hidden", async () => {
    const before = storedEntry();
    mockEntryFindById.mockReturnValue(preImageChain(before));
    mockEntryFindOneAndUpdate.mockResolvedValue(storedEntry({ isDeleted: true }));
    await deleteIncomeEntryService(String(ENTRY), ADMIN, mockRes());

    expect(recordAudit).toHaveBeenCalledTimes(1);
    const entry = recordAudit.mock.calls[0][0];
    expect(entry).toMatchObject({
      userId: ADMIN,
      actionType: "delete",
      entityType: "income_entry",
      entityId: ENTRY,
    });
    expect(entry.summary).toContain("Deleted income");
    expect(entry.summary).toContain("Notes Sale");
    expect(entry.afterSnapshot).toBeUndefined();
    expect(entry.beforeSnapshot).toMatchObject({
      incomeHead: "Notes Sale",
      description: "Notes sold to Grade 9",
      quantity: 2.5,
      unitRate: 45.5,
      totalAmount: 113.75,
    });
  });

  it("invalid id → 400 without reading; unknown entry → 404 without writing", async () => {
    const bad = mockRes();
    await deleteIncomeEntryService("nope", ADMIN, bad);
    expect(bad.status).toHaveBeenCalledWith(400);
    expect(mockEntryFindById).not.toHaveBeenCalled();

    mockEntryFindById.mockReturnValue(preImageChain(null));
    const gone = mockRes();
    await deleteIncomeEntryService(String(ENTRY), ADMIN, gone);
    expect(gone.status).toHaveBeenCalledWith(404);
    expect(mockEntryFindOneAndUpdate).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

// ── schema-level guards (real model, no DB) ─────────────────────────────────
// Hooks are registered with regex operation matchers (^find, ^(updateOne|…)),
// which mongoose expands to concrete hook names.

const SCOPING_HOOK_SOURCE = /isSelfScoped|NOT_DELETED|allowHardDelete/;

function hooksFor(opName) {
  const registered = RealIncomeEntry.schema.s.hooks._pres.get(opName) || [];
  return registered
    .filter((h) => h.fn && SCOPING_HOOK_SOURCE.test(String(h.fn)))
    .map((h) => h.fn);
}

function fakeQuery(filter = {}, options = {}) {
  return {
    _filter: filter,
    _options: options,
    getFilter() {
      return this._filter;
    },
    getOptions() {
      return this._options;
    },
    where(cond) {
      Object.assign(this._filter, cond);
      return this;
    },
  };
}

function runQueryHooks(opName, query) {
  const fns = hooksFor(opName);
  expect(fns.length).toBeGreaterThan(0);
  let error;
  fns.forEach((fn) => fn.call(query, (err) => {
    error = err;
  }));
  if (error) throw error;
  return query.getFilter();
}

describe("IncomeEntry schema — soft-delete scoping and hard-delete refusal", () => {
  it("scopes every read/write so a hidden entry cannot resurface or be edited", () => {
    ["find", "findOne", "countDocuments", "distinct", "updateOne", "updateMany"].forEach((op) => {
      expect(runQueryHooks(op, fakeQuery({ date: { $gte: new Date(2026, 10, 1) } }))).toMatchObject({
        isDeleted: { $ne: true },
      });
    });
  });

  it("leaves a query that already scopes isDeleted (or opts in) exactly once alone", () => {
    const explicit = runQueryHooks("find", fakeQuery({ isDeleted: true }));
    expect(explicit.isDeleted).toBe(true);

    const opted = runQueryHooks("find", fakeQuery({}, { includeDeleted: true }));
    expect(opted).not.toHaveProperty("isDeleted");
  });

  it("prefixes a leading $match onto aggregations (running totals, net summary)", () => {
    const ctx = { options: {}, _pipeline: [{ $group: { _id: null } }] };
    ctx.pipeline = () => ctx._pipeline;
    hooksFor("aggregate").forEach((fn) => fn.call(ctx, () => {}));
    expect(ctx._pipeline[0]).toEqual({ $match: { isDeleted: { $ne: true } } });

    // Already-scoped pipeline → untouched (no duplicate $match).
    const scoped = { options: {}, _pipeline: [{ $match: { isDeleted: { $ne: true } } }] };
    scoped.pipeline = () => scoped._pipeline;
    hooksFor("aggregate").forEach((fn) => fn.call(scoped, () => {}));
    expect(scoped._pipeline).toHaveLength(1);
  });

  it("refuses deleteOne/deleteMany unless a purge is explicitly opted in", () => {
    expect(() => runQueryHooks("deleteOne", fakeQuery({ _id: String(ENTRY) }))).toThrow(/never hard-deleted/);
    expect(() => runQueryHooks("deleteMany", fakeQuery({}))).toThrow(/never hard-deleted/);

    // The documented escape hatch still works — opt-in only.
    const ok = runQueryHooks("deleteOne", fakeQuery({ _id: String(ENTRY) }, { allowHardDelete: true }));
    expect(ok).not.toHaveProperty("isDeleted");
  });
});