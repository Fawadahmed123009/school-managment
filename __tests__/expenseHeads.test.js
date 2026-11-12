/**
 * Expense head service tests (Phase 3):
 * - Create validates the name and dedupes case-insensitively BEFORE any write.
 * - Toggle deactivates/reactivates WITHOUT deleting (history is preserved).
 * - List supports activeOnly (the new-entry dropdown) vs all heads (history filter).
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockFindOne = jest.fn();
const mockCreate = jest.fn();
const mockFindById = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
const mockFind = jest.fn();
const mockCount = jest.fn();

jest.mock("../models/Expenses/expenseHead.model", () => ({
  findOne: (...a) => mockFindOne(...a),
  create: (...a) => mockCreate(...a),
  findById: (...a) => mockFindById(...a),
  findByIdAndUpdate: (...a) => mockFindByIdAndUpdate(...a),
  find: (...a) => mockFind(...a),
  countDocuments: (...a) => mockCount(...a),
}));

const mongoose = require("mongoose");
const {
  createExpenseHeadService,
  getAllExpenseHeadsService,
  toggleExpenseHeadService,
} = require("../services/expenses/expenseHead.service");

const ADMIN = new mongoose.Types.ObjectId();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];
const listChain = (docs) => ({
  skip() { return this; },
  limit() { return this; },
  sort() { return this; },
  lean: jest.fn().mockResolvedValue(docs),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFindOne.mockResolvedValue(null);
  mockCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), isActive: true, ...doc }));
  // Audit-trail pre-read (toggle): default null → no audit row, update unchanged.
  mockFindById.mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(null) });
  mockFind.mockReturnValue(listChain([]));
  mockCount.mockResolvedValue(0);
});

describe("createExpenseHeadService — validation (fail-closed)", () => {
  it("empty/whitespace name → 400 and nothing written", async () => {
    const res = mockRes();
    await createExpenseHeadService({ name: "   " }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("duplicate name (case-insensitive) → 409 and nothing written", async () => {
    mockFindOne.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), name: "Electricity" });
    const res = mockRes();
    await createExpenseHeadService({ name: "electricity" }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockCreate).not.toHaveBeenCalled();
    const filter = mockFindOne.mock.calls[0][0];
    expect(filter.name.$regex.flags).toContain("i");
  });

  it("escapes regex metacharacters so a literal name can't throw", async () => {
    const res = mockRes();
    await createExpenseHeadService({ name: "A+B (C)" }, ADMIN, res);
    const filter = mockFindOne.mock.calls[0][0];
    expect(filter.name.$regex.source).toContain("\\+");
    expect(filter.name.$regex.source).toContain("\\(");
  });

  it("valid → 201 with trimmed name + createdBy", async () => {
    const res = mockRes();
    await createExpenseHeadService({ name: "  Printing — Labor  " }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ name: "Printing — Labor", createdBy: ADMIN });
  });
});

describe("toggleExpenseHeadService — deactivate, never delete", () => {
  it("sets isActive=false via update (no delete path)", async () => {
    const id = new mongoose.Types.ObjectId();
    mockFindByIdAndUpdate.mockResolvedValue({ _id: id, name: "Electricity", isActive: false });
    const res = mockRes();
    await toggleExpenseHeadService(String(id), false, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const [calledId, update] = mockFindByIdAndUpdate.mock.calls[0];
    expect(calledId).toBe(String(id));
    expect(update).toEqual({ isActive: false });
  });

  it("reactivates with isActive=true", async () => {
    const id = new mongoose.Types.ObjectId();
    mockFindByIdAndUpdate.mockResolvedValue({ _id: id, name: "Electricity", isActive: true });
    const res = mockRes();
    await toggleExpenseHeadService(String(id), true, res);
    expect(mockFindByIdAndUpdate.mock.calls[0][1]).toEqual({ isActive: true });
  });

  it("missing head → 404", async () => {
    mockFindByIdAndUpdate.mockResolvedValue(null);
    const res = mockRes();
    await toggleExpenseHeadService(String(new mongoose.Types.ObjectId()), false, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("getAllExpenseHeadsService — dropdown vs history filter", () => {
  it("activeOnly restricts the query to isActive=true", async () => {
    await getAllExpenseHeadsService({ activeOnly: "true", limit: 100 });
    expect(mockFind.mock.calls[0][0]).toEqual({ isActive: true });
  });

  it("no activeOnly → empty filter (every head, incl. inactive)", async () => {
    await getAllExpenseHeadsService({ limit: 100 });
    expect(mockFind.mock.calls[0][0]).toEqual({});
  });

  it("returns the paginated envelope", async () => {
    const head = { _id: new mongoose.Types.ObjectId(), name: "Water", isActive: true };
    mockFind.mockReturnValue(listChain([head]));
    mockCount.mockResolvedValue(1);
    const result = await getAllExpenseHeadsService({});
    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
  });
});
