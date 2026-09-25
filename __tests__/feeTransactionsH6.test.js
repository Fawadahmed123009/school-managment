/**
 * H6 — multi-document fee flows must be atomic (MongoDB transactions).
 *
 * The C2 work added soft-delete + audit trails but left the three
 * multi-write flows (OCR bulk-confirm loop, bulk assign, monthly fee
 * generation) as un-transacted partial-write paths: a mid-loop failure
 * could leave some fee rows applied without their audit rows (or vice
 * versa). This suite locks the transaction plumbing with mocked mongoose
 * sessions:
 *
 *   • success  → session started, every model call carries { session },
 *                commitTransaction + endSession exactly once;
 *   • failure  → the FIRST model write succeeded but a later one throws →
 *                abortTransaction (full rollback), error propagates to the
 *                controller's 400 handler;
 *   • no session support (standalone mongod) → transparent degrade to the
 *     pre-H6 non-transactional execution;
 *   • single-doc flows (createFee/updateFee/deleteFee) never consume a
 *     session and behave as before.
 */

// ── Mocked session machinery ─────────────────────────────────────────
const mockStartTransaction = jest.fn();
const mockCommitTransaction = jest.fn();
const mockAbortTransaction = jest.fn();
const mockEndSession = jest.fn();
const mockSession = {
  startTransaction: mockStartTransaction,
  commitTransaction: mockCommitTransaction,
  abortTransaction: mockAbortTransaction,
  endSession: mockEndSession,
};
const mockStartSession = jest.fn();
const mockConnectionClient = { startSession: mockStartSession };

jest.mock("mongoose", () => ({
  connection: {
    get client() {
      return mockConnectionClient;
    },
  },
}));

// ── Model mocks ───────────────────────────────────────────────────────
const mockFeeAudit = { create: jest.fn() };
jest.mock("../models/Fees/feeAudit.model", () => mockFeeAudit);

const mockFees = {
  find: jest.fn(),
  create: jest.fn(),
  insertMany: jest.fn(),
  populate: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
};
jest.mock("../models/Fees/fees.model", () => mockFees);

const mockFeeHeadFindById = jest.fn();
const mockFeeHead = {
  findById: (...a) => mockFeeHeadFindById(...a),
  findOne: jest.fn(),
};
jest.mock("../models/Fees/feeHead.model", () => mockFeeHead);

const mockStudentFind = jest.fn();
const mockStudentCountDocuments = jest.fn();
jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
  countDocuments: (...a) => mockStudentCountDocuments(...a),
}));

// createFeeService promotes a typed feeType via findOrCreateFeeHeadByName —
// stub it (its own behavior is covered by findOrCreateFeeHead.test.js).
jest.mock("../services/fees/feeHead.service", () => ({
  findOrCreateFeeHeadByName: jest.fn().mockResolvedValue(null),
}));

const feesService = require("../services/fees/fees.service");
const {
  bulkCreateFeesService,
  bulkAssignFeesService,
  generateMonthlyFeesService,
  createFeeService,
} = feesService;

// ── Helpers ───────────────────────────────────────────────────────────
// Chainable find stub: select(...).lean() → rows (also awaitable directly).
function makeFindChain(rows) {
  const chain = {
    select: jest.fn(() => chain),
    lean: jest.fn(() => Promise.resolve(rows)),
    then: (cb) => Promise.resolve(rows).then(cb),
  };
  return chain;
}

function makeRes() {
  const res = {};
  res._statusCode = null;
  res._body = null;
  res.status = jest.fn((c) => {
    res._statusCode = c;
    return res;
  });
  res.json = jest.fn((b) => {
    res._body = b;
    return res;
  });
  return res;
}

const sessionOpts = (callArgs) => callArgs[callArgs.length - 1];

beforeEach(() => {
  jest.clearAllMocks();
  // Default: a working replica-set session.
  mockStartSession.mockReturnValue(mockSession);
  mockCommitTransaction.mockResolvedValue(undefined);
  mockAbortTransaction.mockResolvedValue(undefined);
  mockFeeAudit.create.mockResolvedValue([{ _id: "audit-1" }]);
});

// ── OCR bulk-confirm loop ────────────────────────────────────────────
describe("H6 — bulkCreateFeesService is transactional", () => {
  const makeFeeDoc = (over = {}) => ({
    _id: "fee-x",
    student: "student-aaa",
    amount: 5000,
    status: "pending",
    feeType: "tuition",
    notes: "",
    source: "manual",
    toObject() {
      return { ...this };
    },
    save: jest.fn().mockResolvedValue(undefined),
    ...over,
  });

  function stubPendingQuery(docs) {
    const chain = { sort: jest.fn(() => chain), session: jest.fn(() => chain) };
    Object.defineProperty(chain, "then", {
      value: (cb) => Promise.resolve(docs).then(cb),
    });
    mockFees.find.mockReturnValue(chain);
    return chain;
  }

  test("success path: session started, every write carries it, committed once", async () => {
    const fee = makeFeeDoc();
    const chain = stubPendingQuery([fee]);

    const res = makeRes();
    await bulkCreateFeesService([{ student: "student-aaa", amount: 5000 }], "admin-1", res);

    expect(res._statusCode).toBe(201);
    expect(mockStartSession).toHaveBeenCalledTimes(1);
    expect(mockStartTransaction).toHaveBeenCalledTimes(1);
    expect(chain.session).toHaveBeenCalledWith(mockSession);
    expect(fee.save).toHaveBeenCalledWith({ session: mockSession });
    const auditArgs = mockFeeAudit.create.mock.calls[0];
    expect(auditArgs[0][0].action).toBe("update");
    expect(auditArgs[1]).toEqual({ session: mockSession });
    expect(mockCommitTransaction).toHaveBeenCalledTimes(1);
    expect(mockAbortTransaction).not.toHaveBeenCalled();
    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  test("mid-loop failure: transaction aborted (partial writes rolled back), error propagates", async () => {
    const fee = makeFeeDoc();
    stubPendingQuery([fee]);
    // The fee save succeeds, the audit write fails → without a transaction
    // this is exactly the state that left paid fees with no audit row.
    fee.save.mockResolvedValue(undefined);
    mockFeeAudit.create.mockRejectedValue(new Error("audit write exploded"));

    const res = makeRes();
    await expect(
      bulkCreateFeesService([{ student: "student-aaa", amount: 5000 }], "admin-1", res)
    ).rejects.toThrow("audit write exploded");

    expect(mockAbortTransaction).toHaveBeenCalledTimes(1);
    expect(mockCommitTransaction).not.toHaveBeenCalled();
    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  test("standalone (startSession throws): degrades to the non-transactional path", async () => {
    mockStartSession.mockImplementation(() => {
      throw new Error("Instance does not support running transactions in stand-alone mode");
    });
    const fee = makeFeeDoc();
    const chain = stubPendingQuery([fee]);

    const res = makeRes();
    await bulkCreateFeesService([{ student: "student-aaa", amount: 5000 }], "admin-1", res);

    expect(res._statusCode).toBe(201);
    expect(fee.save).toHaveBeenCalledWith({});
    expect(chain.session).not.toHaveBeenCalled();
    expect(mockCommitTransaction).not.toHaveBeenCalled();
    expect(mockFeeAudit.create).toHaveBeenCalled();
  });
});

// ── Bulk assign ──────────────────────────────────────────────────────
describe("H6 — bulkAssignFeesService inserts + audits inside one transaction", () => {
  const FEE_HEAD = { _id: "fh-1", name: "Tuition", defaultAmount: 5000 };

  beforeEach(() => {
    mockFeeHeadFindById.mockResolvedValue(FEE_HEAD);

    const studentChain = makeFindChain([
      { _id: "s1", feeAgreed: null },
      { _id: "s2", feeAgreed: "6000" },
    ]);
    mockStudentFind.mockReturnValue(studentChain);
    mockFees.find.mockReturnValue(makeFindChain([])); // no existing
    mockFees.insertMany.mockResolvedValue([{ _id: "f1" }, { _id: "f2" }]);
  });

  test("insertMany and its audit row receive the same session; committed", async () => {
    const res = makeRes();
    await bulkAssignFeesService(
      { feeHead: "fh-1", targetType: "all" },
      "admin-1",
      res
    );

    expect(res._statusCode).toBe(201);
    expect(mockStartTransaction).toHaveBeenCalledTimes(1);
    expect(mockFees.insertMany).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ student: "s1" })]),
      { ordered: false, session: mockSession }
    );
    expect(mockFeeAudit.create.mock.calls[0][1]).toEqual({ session: mockSession });
    expect(mockCommitTransaction).toHaveBeenCalledTimes(1);
    expect(mockEndSession).toHaveBeenCalledTimes(1);
  });

  test("audit failure rolls the whole batch back", async () => {
    mockFeeAudit.create.mockRejectedValue(new Error("audit db down"));
    const res = makeRes();
    await expect(
      bulkAssignFeesService({ feeHead: "fh-1", targetType: "all" }, "admin-1", res)
    ).rejects.toThrow("audit db down");
    expect(mockAbortTransaction).toHaveBeenCalledTimes(1);
    expect(mockCommitTransaction).not.toHaveBeenCalled();
  });
});

// ── Monthly generation ───────────────────────────────────────────────
describe("H6 — generateMonthlyFeesService is transactional", () => {
  beforeEach(() => {
    // FeeHead.findOne(...).lean() → the Tuition head
    mockFeeHead.findOne.mockResolvedValue({
      _id: "fh-tuition",
      name: "Tuition",
      defaultAmount: 4000,
      isActive: true,
    });
    mockStudentFind.mockReturnValue(
      makeFindChain([{ _id: "s1", name: "Ali", feeAgreed: null }])
    );
    mockStudentCountDocuments.mockResolvedValue(0);
    mockFees.find.mockReturnValue(makeFindChain([])); // nobody has this month's fee yet
    mockFees.insertMany.mockResolvedValue([{ _id: "f1" }]);
  });

  test("fee rows + audit row share one session and commit together", async () => {
    const res = makeRes();
    await generateMonthlyFeesService("admin-1", res);

    expect(res._statusCode).toBe(201);
    expect(mockStartTransaction).toHaveBeenCalledTimes(1);
    expect(mockFees.insertMany.mock.calls[0][1]).toEqual({ ordered: false, session: mockSession });
    expect(mockFeeAudit.create.mock.calls[0][1]).toEqual({ session: mockSession });
    expect(mockCommitTransaction).toHaveBeenCalledTimes(1);
  });

  test("insert failure aborts the transaction — no orphan audit row", async () => {
    mockFees.insertMany.mockRejectedValue(new Error("insert exploded"));
    const res = makeRes();
    await expect(generateMonthlyFeesService("admin-1", res)).rejects.toThrow("insert exploded");
    expect(mockAbortTransaction).toHaveBeenCalledTimes(1);
    expect(mockFeeAudit.create).not.toHaveBeenCalled();
    expect(mockCommitTransaction).not.toHaveBeenCalled();
  });

  test("nothing to generate → no transaction is opened", async () => {
    // Every active student already has this month's fee:
    mockFees.find.mockReturnValue(makeFindChain([{ student: "s1" }]));
    const res = makeRes();
    await generateMonthlyFeesService("admin-1", res);

    expect(mockStartSession).not.toHaveBeenCalled();
    expect(mockFees.insertMany).not.toHaveBeenCalled();
  });
});

// ── Single-document flows must NOT touch sessions ────────────────────
describe("H6 — single-doc flows stay session-free", () => {
  test("createFeeService: one doc + one audit, no transaction started", async () => {
    mockFees.create.mockResolvedValue({
      _id: "f9",
      student: "s9",
      amount: 100,
      feeType: "Exam Fee",
      status: "pending",
    });
    const res = makeRes();
    await createFeeService({ feeType: "Exam Fee", amount: 100, student: "s9" }, "admin-1", res);

    expect(res._statusCode).toBe(201);
    expect(mockStartSession).not.toHaveBeenCalled();
    expect(mockFeeAudit.create).toHaveBeenCalled();
  });
});
