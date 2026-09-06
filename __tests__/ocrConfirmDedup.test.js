/**
 * Tests bulkCreateFeesService — OCR confirmation dedup logic.
 *
 * Three scenarios:
 * 1. Student has exactly ONE pending fee with matching amount → updated to "paid"
 * 2. Student has NO pending fee with matching amount → new "paid" record created
 * 3. Student has TWO+ pending fees with matching amount → flagged for review (needsReview)
 */

// ── Model mocks ──────────────────────────────────────────────────────────────

const mockFind = jest.fn();
const mockCreate = jest.fn();
const mockPopulate = jest.fn();
const mockInsertMany = jest.fn();

// Helper: create a mock fee document with save()
const makeMockFee = (overrides = {}) => {
  const doc = {
    _id: "fee-" + Math.random().toString(36).slice(2, 8),
    student: "student-default",
    amount: 0,
    status: "pending",
    feeType: "tuition",
    notes: "",
    source: "manual",
    createdAt: new Date("2026-01-15"),
    ...overrides,
  };
  doc.save = jest.fn(async () => {
    return doc;
  });
  return doc;
};

jest.mock("../models/Fees/fees.model", () => {
  const model = function FeeDoc(data) {
    Object.assign(this, data);
  };
  model.find = (...args) => mockFind(...args);
  model.create = (...args) => mockCreate(...args);
  model.insertMany = (...args) => mockInsertMany(...args);
  model.populate = (...args) => mockPopulate(...args);
  return model;
});

jest.mock("../models/Fees/feeHead.model", () => ({}));
jest.mock("../models/Students/students.model", () => ({}));

const { bulkCreateFeesService } = require("../services/fees/fees.service");

const ADMIN_ID = "admin-001";
const STUDENT_A = "student-aaa";
const STUDENT_B = "student-bbb";
const STUDENT_C = "student-ccc";

let fakeRes;

beforeEach(() => {
  jest.clearAllMocks();
  fakeRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  fakeRes.status.mockImplementation((code) => {
    fakeRes._statusCode = code;
    return fakeRes;
  });
  fakeRes.json.mockImplementation((body) => {
    fakeRes._body = body;
    return fakeRes;
  });
});

// ── Scenario 1: Exact match → update existing pending fee to paid ────────────

describe("Scenario 1: One pending fee matches → update to paid", () => {
  test("updates the existing pending fee to 'paid' instead of creating a duplicate", async () => {
    const existingFee = makeMockFee({
      _id: "fee-existing",
      student: STUDENT_A,
      amount: 5000,
      status: "pending",
      notes: "Term 1 tuition",
    });

    // Fees.find returns exactly one pending fee with matching amount
    mockFind.mockReturnValue({
      sort: jest.fn().mockResolvedValue([existingFee]),
    });

    const rows = [{ student: STUDENT_A, amount: 5000 }];
    await bulkCreateFeesService(rows, ADMIN_ID, fakeRes);

    // Should NOT have created a new record
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockInsertMany).not.toHaveBeenCalled();

    // Should have updated the existing fee
    expect(existingFee.save).toHaveBeenCalledTimes(1);
    expect(existingFee.status).toBe("paid");
    expect(existingFee.datePaid).toBeInstanceOf(Date);
    expect(existingFee.notes).toContain("Marked paid via OCR confirmation");

    // Response should report 1 updated, 0 created, 0 needsReview
    const data = fakeRes._body.data;
    expect(data.summary.updated).toBe(1);
    expect(data.summary.created).toBe(0);
    expect(data.summary.needsReview).toBe(0);
    expect(data.updated).toHaveLength(1);
    expect(data.needsReview).toHaveLength(0);
  });

  test("preserves existing notes and appends OCR confirmation note", async () => {
    const existingFee = makeMockFee({
      _id: "fee-with-notes",
      student: STUDENT_A,
      amount: 3000,
      status: "pending",
      notes: "Original note",
    });

    mockFind.mockReturnValue({
      sort: jest.fn().mockResolvedValue([existingFee]),
    });

    await bulkCreateFeesService([{ student: STUDENT_A, amount: 3000 }], ADMIN_ID, fakeRes);

    expect(existingFee.notes).toContain("Original note");
    expect(existingFee.notes).toContain("Marked paid via OCR confirmation");
  });
});

// ── Scenario 2: No match → create new paid record ────────────────────────────

describe("Scenario 2: No pending fee matches → create new paid record", () => {
  test("creates a new fee record with status 'paid' and source 'ocr'", async () => {
    // Fees.find returns empty — no pending fees
    mockFind.mockReturnValue({
      sort: jest.fn().mockResolvedValue([]),
    });

    const newFee = {
      _id: "fee-new",
      student: STUDENT_B,
      amount: 7500,
      status: "paid",
      source: "ocr",
      recordedBy: ADMIN_ID,
    };
    mockCreate.mockResolvedValue([newFee]);

    const rows = [{ student: STUDENT_B, amount: 7500 }];
    await bulkCreateFeesService(rows, ADMIN_ID, fakeRes);

    // Should have called Fees.create (not insertMany)
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0][0];
    expect(createArg.student).toBe(STUDENT_B);
    expect(createArg.amount).toBe(7500);
    expect(createArg.status).toBe("paid");
    expect(createArg.source).toBe("ocr");
    expect(createArg.datePaid).toBeInstanceOf(Date);

    // Should NOT have found any pending fees to update
    expect(mockFind).toHaveBeenCalled();

    const data = fakeRes._body.data;
    expect(data.summary.created).toBe(1);
    expect(data.summary.updated).toBe(0);
    expect(data.summary.needsReview).toBe(0);
  });
});

// ── Scenario 3: Ambiguous → flag for review ─────────────────────────────────

describe("Scenario 3: Multiple pending fees with same amount → flag for review", () => {
  test("returns needsReview with candidate details instead of auto-resolving", async () => {
    const fee1 = makeMockFee({
      _id: "fee-1",
      student: STUDENT_C,
      amount: 4000,
      status: "pending",
      feeType: "tuition",
      createdAt: new Date("2026-01-10"),
    });
    const fee2 = makeMockFee({
      _id: "fee-2",
      student: STUDENT_C,
      amount: 4000,
      status: "pending",
      feeType: "exam",
      createdAt: new Date("2026-02-20"),
    });

    // Fees.find returns two pending fees with same amount
    mockFind.mockReturnValue({
      sort: jest.fn().mockResolvedValue([fee1, fee2]),
    });

    // Fees.populate resolves student info
    mockPopulate.mockResolvedValue([
      { ...fee1, student: { name: "Charlie Brown", rollNumber: "042" } },
      { ...fee2, student: { name: "Charlie Brown", rollNumber: "042" } },
    ]);

    const rows = [{ student: STUDENT_C, amount: 4000 }];
    await bulkCreateFeesService(rows, ADMIN_ID, fakeRes);

    // Should NOT have saved either fee (no auto-resolution)
    expect(fee1.save).not.toHaveBeenCalled();
    expect(fee2.save).not.toHaveBeenCalled();

    // Should NOT have created a new record
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockInsertMany).not.toHaveBeenCalled();

    // Should have flagged for review
    const data = fakeRes._body.data;
    expect(data.summary.needsReview).toBe(1);
    expect(data.summary.created).toBe(0);
    expect(data.summary.updated).toBe(0);
    expect(data.needsReview).toHaveLength(1);

    const reviewItem = data.needsReview[0];
    expect(reviewItem.studentId).toBe(STUDENT_C);
    expect(reviewItem.amount).toBe(4000);
    expect(reviewItem.candidates).toHaveLength(2);
    expect(reviewItem.candidates[0]._id).toBe("fee-1");
    expect(reviewItem.candidates[1]._id).toBe("fee-2");
  });

  test("does not guess even when candidates have different fee types", async () => {
    const fee1 = makeMockFee({ _id: "fee-a", student: STUDENT_C, amount: 2000, feeType: "tuition" });
    const fee2 = makeMockFee({ _id: "fee-b", student: STUDENT_C, amount: 2000, feeType: "transport" });
    const fee3 = makeMockFee({ _id: "fee-c", student: STUDENT_C, amount: 2000, feeType: "exam" });

    mockFind.mockReturnValue({
      sort: jest.fn().mockResolvedValue([fee1, fee2, fee3]),
    });
    mockPopulate.mockResolvedValue([
      { ...fee1, student: { name: "Charlie Brown" } },
      { ...fee2, student: { name: "Charlie Brown" } },
      { ...fee3, student: { name: "Charlie Brown" } },
    ]);

    await bulkCreateFeesService([{ student: STUDENT_C, amount: 2000 }], ADMIN_ID, fakeRes);

    // 3 candidates flagged, none auto-resolved
    const data = fakeRes._body.data;
    expect(data.needsReview[0].candidates).toHaveLength(3);
    expect(fee1.save).not.toHaveBeenCalled();
    expect(fee2.save).not.toHaveBeenCalled();
    expect(fee3.save).not.toHaveBeenCalled();
  });
});

// ── Mixed batch: all three scenarios in one call ─────────────────────────────

describe("Mixed batch: all scenarios in a single OCR confirmation", () => {
  test("processes each row independently", async () => {
    // Row 1: STUDENT_A has one pending match → update
    const existingA = makeMockFee({ _id: "fee-a", student: STUDENT_A, amount: 5000, status: "pending" });

    // Row 2: STUDENT_B has no match → create
    // Row 3: STUDENT_C has two matches → review

    const feeC1 = makeMockFee({ _id: "fee-c1", student: STUDENT_C, amount: 3000, status: "pending" });
    const feeC2 = makeMockFee({ _id: "fee-c2", student: STUDENT_C, amount: 3000, status: "pending" });

    // Control what Fees.find returns per call
    mockFind
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue([existingA]) })  // STUDENT_A
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue([]) })            // STUDENT_B
      .mockReturnValueOnce({ sort: jest.fn().mockResolvedValue([feeC1, feeC2]) }); // STUDENT_C

    mockCreate.mockResolvedValue([{ _id: "fee-new-b", student: STUDENT_B, amount: 7000, status: "paid" }]);
    mockPopulate.mockResolvedValue([
      { ...feeC1, student: { name: "Charlie" } },
      { ...feeC2, student: { name: "Charlie" } },
    ]);

    const rows = [
      { student: STUDENT_A, amount: 5000 },
      { student: STUDENT_B, amount: 7000 },
      { student: STUDENT_C, amount: 3000 },
    ];

    await bulkCreateFeesService(rows, ADMIN_ID, fakeRes);

    const data = fakeRes._body.data;
    expect(data.summary.updated).toBe(1);
    expect(data.summary.created).toBe(1);
    expect(data.summary.needsReview).toBe(1);

    // STUDENT_A's fee was updated
    expect(existingA.status).toBe("paid");
    expect(existingA.save).toHaveBeenCalledTimes(1);

    // STUDENT_B got a new record
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // STUDENT_C was flagged
    expect(data.needsReview).toHaveLength(1);
  });
});

// ── Invalid amounts still rejected ───────────────────────────────────────────

describe("Input validation", () => {
  test("rejects rows with null or zero amounts before any DB work", async () => {
    const rows = [
      { student: STUDENT_A, amount: null },
      { student: STUDENT_B, amount: 0 },
    ];

    await bulkCreateFeesService(rows, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
