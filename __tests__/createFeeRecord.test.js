/**
 * Tests createFeeService — verifies that manually adding a fee record always
 * inserts a NEW document (via Fees.create), never overwrites an existing one.
 *
 *   • Adding a second fee record for the same student (different fee head)
 *     creates both records — the first is NOT deleted/overwritten.
 *   • Adding two records with the SAME fee head for the same student also
 *     creates both (manual entry allows duplicate fee heads as separate charges).
 *   • The service always calls Fees.create (insert), never findOneAndUpdate
 *     or any upsert variant.
 *   • When a custom feeType is provided without a feeHead reference, the
 *     service promotes it to a real FeeHead catalog entry via
 *     findOrCreateFeeHeadByName and links the fee record to it.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockFeesCreate = jest.fn();
const mockFindOrCreate = jest.fn();

jest.mock("../models/Fees/fees.model", () => ({
  create: (...a) => mockFeesCreate(...a),
}));

jest.mock("../models/Fees/feeHead.model", () => ({}));
jest.mock("../models/Students/students.model", () => ({}));
jest.mock("../services/fees/feeHead.service", () => ({
  findOrCreateFeeHeadByName: (...a) => mockFindOrCreate(...a),
}));

const { createFeeService } = require("../services/fees/fees.service");

const ADMIN_ID = "admin-abc";
const STUDENT_1 = "student-001";
const FEE_HEAD_TUITION = "head-tuition";
const FEE_HEAD_TRANSPORT = "head-transport";

let fakeRes;

beforeEach(() => {
  jest.clearAllMocks();
  // Mock response object — createFeeService passes it to responseStatus()
  fakeRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  // Make responseStatus work: res.status(code).json(body)
  fakeRes.status.mockImplementation((code) => {
    fakeRes._statusCode = code;
    return fakeRes;
  });
  fakeRes.json.mockImplementation((body) => {
    fakeRes._body = body;
    return fakeRes;
  });

  mockFeesCreate.mockImplementation(async (doc) => ({
    _id: "fee-" + Math.random().toString(36).slice(2, 8),
    ...doc,
  }));
});

describe("createFeeService — always inserts, never overwrites", () => {
  test("creates a new fee record via Fees.create (not findOneAndUpdate/upsert)", async () => {
    const data = {
      student: STUDENT_1,
      feeHead: FEE_HEAD_TUITION,
      feeType: "Tuition",
      amount: 5000,
    };

    await createFeeService(data, ADMIN_ID, fakeRes);

    expect(mockFeesCreate).toHaveBeenCalledTimes(1);
    const created = mockFeesCreate.mock.calls[0][0];
    expect(created.student).toBe(STUDENT_1);
    expect(created.feeHead).toBe(FEE_HEAD_TUITION);
    expect(created.amount).toBe(5000);
    expect(created.recordedBy).toBe(ADMIN_ID);
    // Must NOT contain an _id (would hint at upsert behavior)
    expect(created._id).toBeUndefined();
  });

  test("adding a second fee record (different fee head) does NOT touch the first", async () => {
    // First record: Tuition
    await createFeeService(
      { student: STUDENT_1, feeHead: FEE_HEAD_TUITION, feeType: "Tuition", amount: 5000 },
      ADMIN_ID,
      fakeRes,
    );

    // Second record: Transport (same student)
    await createFeeService(
      { student: STUDENT_1, feeHead: FEE_HEAD_TRANSPORT, feeType: "Transport", amount: 3000 },
      ADMIN_ID,
      fakeRes,
    );

    // Fees.create was called twice — two independent inserts
    expect(mockFeesCreate).toHaveBeenCalledTimes(2);

    // Verify the two calls had different fee heads
    const firstCall = mockFeesCreate.mock.calls[0][0];
    const secondCall = mockFeesCreate.mock.calls[1][0];
    expect(firstCall.feeHead).toBe(FEE_HEAD_TUITION);
    expect(secondCall.feeHead).toBe(FEE_HEAD_TRANSPORT);

    // Both for the same student
    expect(firstCall.student).toBe(STUDENT_1);
    expect(secondCall.student).toBe(STUDENT_1);
  });

  test("adding two records with the SAME fee head for the same student also creates both", async () => {
    // First Tuition charge
    await createFeeService(
      { student: STUDENT_1, feeHead: FEE_HEAD_TUITION, feeType: "Tuition", amount: 5000 },
      ADMIN_ID,
      fakeRes,
    );

    // Second Tuition charge (e.g. a separate billing for a different period)
    await createFeeService(
      { student: STUDENT_1, feeHead: FEE_HEAD_TUITION, feeType: "Tuition", amount: 5000 },
      ADMIN_ID,
      fakeRes,
    );

    // Both should be created — manual entry allows duplicate fee heads
    expect(mockFeesCreate).toHaveBeenCalledTimes(2);
    expect(mockFeesCreate.mock.calls[0][0].feeHead).toBe(FEE_HEAD_TUITION);
    expect(mockFeesCreate.mock.calls[1][0].feeHead).toBe(FEE_HEAD_TUITION);
  });

  test("returns 201 status on successful creation", async () => {
    await createFeeService(
      { student: STUDENT_1, feeHead: FEE_HEAD_TUITION, feeType: "Tuition", amount: 5000 },
      ADMIN_ID,
      fakeRes,
    );

    expect(fakeRes._statusCode).toBe(201);
  });
});

describe("createFeeService — custom fee head promotion", () => {
  test("promotes a typed feeType to a FeeHead when no feeHead is provided", async () => {
    const newHead = { _id: "new-head-id", name: "Sports Day" };
    mockFindOrCreate.mockResolvedValue(newHead);

    await createFeeService(
      { student: STUDENT_1, feeType: "Sports Day", amount: 500 },
      ADMIN_ID,
      fakeRes,
    );

    expect(mockFindOrCreate).toHaveBeenCalledWith("Sports Day", ADMIN_ID);
    expect(mockFeesCreate).toHaveBeenCalledTimes(1);
    const created = mockFeesCreate.mock.calls[0][0];
    expect(created.feeHead).toBe("new-head-id");
    expect(created.feeType).toBe("Sports Day");
  });

  test("reuses an existing FeeHead (case-insensitive) instead of creating a duplicate", async () => {
    const existingHead = { _id: "existing-head-id", name: "Lab Fee" };
    mockFindOrCreate.mockResolvedValue(existingHead);

    await createFeeService(
      { student: STUDENT_1, feeType: "lab fee", amount: 300 },
      ADMIN_ID,
      fakeRes,
    );

    expect(mockFindOrCreate).toHaveBeenCalledWith("lab fee", ADMIN_ID);
    const created = mockFeesCreate.mock.calls[0][0];
    expect(created.feeHead).toBe("existing-head-id");
    expect(created.feeType).toBe("Lab Fee");
  });

  test("does NOT call findOrCreateFeeHeadByName when feeHead is already provided", async () => {
    await createFeeService(
      { student: STUDENT_1, feeHead: FEE_HEAD_TUITION, feeType: "Tuition", amount: 5000 },
      ADMIN_ID,
      fakeRes,
    );

    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });
});
