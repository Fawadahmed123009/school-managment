/**
 * Tests generateMonthlyFeesService — verifies that per-student feeAgreed
 * overrides are correctly applied when generating monthly Tuition fees.
 *
 * Scenarios:
 *   1. Student with feeAgreed = 500 (default = 2000) → fee record shows Rs 500
 *   2. Student with feeAgreed = 0 (scholarship) → fee record shows Rs 0
 *   3. Student with no feeAgreed set (null) → fee record shows default Rs 2000
 *   4. Re-running for same month doesn't double-charge (idempotency)
 *   5. Empty-string feeAgreed treated as "not set" → falls back to default
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockFeeHeadFindOne = jest.fn();
const mockStudentFind = jest.fn();
const mockStudentCountDocuments = jest.fn();
const mockFeesFind = jest.fn();
const mockFeesInsertMany = jest.fn();

jest.mock("../models/Fees/feeHead.model", () => ({
  findOne: (...a) => mockFeeHeadFindOne(...a),
}));

jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
  countDocuments: (...a) => mockStudentCountDocuments(...a),
}));

jest.mock("../models/Fees/fees.model", () => ({
  find: (...a) => mockFeesFind(...a),
  insertMany: (...a) => mockFeesInsertMany(...a),
}));

jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
  countDocuments: (...a) => mockStudentCountDocuments(...a),
}));

// Mock FeeHead service (not directly used by generateMonthlyFeesService but required by module)
jest.mock("../services/fees/feeHead.service", () => ({
  findOrCreateFeeHeadByName: jest.fn(),
}));

const { generateMonthlyFeesService } = require("../services/fees/fees.service");

const ADMIN_ID = "admin-123";
const TUITION_HEAD_ID = "tuition-head-id";
const DEFAULT_AMOUNT = 2000;

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

  // Default mocks: Tuition fee head exists with defaultAmount = 2000
  mockFeeHeadFindOne.mockResolvedValue({
    _id: TUITION_HEAD_ID,
    name: "Tuition",
    defaultAmount: DEFAULT_AMOUNT,
    isActive: true,
  });

  // No existing fees for this month (no duplicates)
  mockFeesFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve([]),
    }),
  });

  // insertMany returns the docs passed in (with _ids added)
  mockFeesInsertMany.mockImplementation(async (docs) =>
    docs.map((d, i) => ({ _id: `fee-id-${i}`, ...d }))
  );

  mockStudentCountDocuments.mockResolvedValue(0);
});

// Helper to set up active students
function setActiveStudents(students) {
  mockStudentFind.mockReturnValue({
    select: () => ({
      lean: () => Promise.resolve(students),
    }),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("generateMonthlyFeesService — feeAgreed override", () => {
  test("uses feeAgreed (custom amount) instead of default when set", async () => {
    setActiveStudents([
      { _id: "student-1", feeAgreed: "500" }, // stored as String in DB
    ]);

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    expect(mockFeesInsertMany).toHaveBeenCalledTimes(1);
    const insertedDocs = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(1);
    expect(insertedDocs[0].amount).toBe(500); // Number, not string "500"
    expect(insertedDocs[0].student).toBe("student-1");
  });

  test("uses feeAgreed = 0 for scholarship students (not default)", async () => {
    setActiveStudents([
      { _id: "student-2", feeAgreed: "0" }, // stored as String "0" in DB
    ]);

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    const insertedDocs = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(1);
    expect(insertedDocs[0].amount).toBe(0); // 0, not 2000
    expect(insertedDocs[0].student).toBe("student-2");
  });

  test("falls back to fee head default when feeAgreed is null", async () => {
    setActiveStudents([
      { _id: "student-3", feeAgreed: null },
    ]);

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    const insertedDocs = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(1);
    expect(insertedDocs[0].amount).toBe(DEFAULT_AMOUNT); // 2000
  });

  test("falls back to default when feeAgreed is empty string (legacy data)", async () => {
    setActiveStudents([
      { _id: "student-4", feeAgreed: "" },
    ]);

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    const insertedDocs = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(1);
    expect(insertedDocs[0].amount).toBe(DEFAULT_AMOUNT); // 2000, not ""
  });

  test("handles mixed students correctly in one run", async () => {
    setActiveStudents([
      { _id: "student-a", feeAgreed: "500" },   // custom
      { _id: "student-b", feeAgreed: "0" },      // scholarship
      { _id: "student-c", feeAgreed: null },      // default
      { _id: "student-d", feeAgreed: undefined }, // default
      { _id: "student-e", feeAgreed: "" },        // legacy empty → default
    ]);

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    const insertedDocs = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(5);

    const byStudent = {};
    insertedDocs.forEach((d) => { byStudent[d.student] = d.amount; });

    expect(byStudent["student-a"]).toBe(500);
    expect(byStudent["student-b"]).toBe(0);
    expect(byStudent["student-c"]).toBe(DEFAULT_AMOUNT);
    expect(byStudent["student-d"]).toBe(DEFAULT_AMOUNT);
    expect(byStudent["student-e"]).toBe(DEFAULT_AMOUNT);
  });
});

describe("generateMonthlyFeesService — idempotency (no double-charge)", () => {
  test("skips students who already have a fee for this month", async () => {
    setActiveStudents([
      { _id: "student-x", name: "X", feeAgreed: "500" },
      { _id: "student-y", name: "Y", feeAgreed: null },
    ]);

    // student-x already has a fee this month
    mockFeesFind.mockReturnValue({
      select: () => ({
        lean: () => Promise.resolve([{ student: "student-x" }]),
      }),
    });

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    const insertedDocs = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(1);
    expect(insertedDocs[0].student).toBe("student-y"); // only student-y gets a new record
    expect(insertedDocs[0].amount).toBe(DEFAULT_AMOUNT);

    // Verify the response mentions 1 already generated
    const responseData = fakeRes._body.data;
    expect(responseData.alreadyGenerated).toBe(1);
    expect(responseData.generated).toBe(1);
  });
});

// ── Tests: no-default-amount scenarios ───────────────────────────────────────

describe("generateMonthlyFeesService — fee head with no default amount", () => {
  beforeEach(() => {
    // Override: Tuition fee head exists but has NO default amount (0)
    mockFeeHeadFindOne.mockResolvedValue({
      _id: TUITION_HEAD_ID,
      name: "Tuition",
      defaultAmount: 0,
      isActive: true,
    });
  });

  test("succeeds for ALL students when every student has feeAgreed set", async () => {
    setActiveStudents([
      { _id: "s1", name: "Alice", feeAgreed: "500" },
      { _id: "s2", name: "Bob", feeAgreed: "0" },      // scholarship
      { _id: "s3", name: "Carol", feeAgreed: "1000" },
    ]);

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    const insertedDocs = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(3);

    const byStudent = {};
    insertedDocs.forEach((d) => { byStudent[d.student] = d.amount; });
    expect(byStudent["s1"]).toBe(500);
    expect(byStudent["s2"]).toBe(0);
    expect(byStudent["s3"]).toBe(1000);

    // No students skipped for missing amount
    const responseData = fakeRes._body.data;
    expect(responseData.skippedNoAmount).toBe(0);
    expect(responseData.skippedNoAmountNames).toEqual([]);
  });

  test("skips only students without feeAgreed when no default available", async () => {
    setActiveStudents([
      { _id: "s1", name: "Alice", feeAgreed: "500" },
      { _id: "s2", name: "Bob", feeAgreed: null },       // no feeAgreed, no default → skip
      { _id: "s3", name: "Carol", feeAgreed: "" },        // empty = not set → skip
      { _id: "s4", name: "Dave", feeAgreed: "0" },        // scholarship → include
    ]);

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    const insertedDocs = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(2); // Alice + Dave only

    const byStudent = {};
    insertedDocs.forEach((d) => { byStudent[d.student] = d.amount; });
    expect(byStudent["s1"]).toBe(500);
    expect(byStudent["s4"]).toBe(0);

    // Bob and Carol skipped
    const responseData = fakeRes._body.data;
    expect(responseData.skippedNoAmount).toBe(2);
    expect(responseData.skippedNoAmountNames).toContain("Bob");
    expect(responseData.skippedNoAmountNames).toContain("Carol");
    expect(responseData.generated).toBe(2);
  });

  test("skips ALL students when none have feeAgreed and no default set", async () => {
    setActiveStudents([
      { _id: "s1", name: "Alice", feeAgreed: null },
      { _id: "s2", name: "Bob", feeAgreed: undefined },
    ]);

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    // No insertMany call since no rows to insert
    expect(mockFeesInsertMany).not.toHaveBeenCalled();

    const responseData = fakeRes._body.data;
    expect(responseData.generated).toBe(0);
    expect(responseData.skippedNoAmount).toBe(2);
    expect(responseData.skippedNoAmountNames).toContain("Alice");
    expect(responseData.skippedNoAmountNames).toContain("Bob");
  });
});

describe("generateMonthlyFeesService — feeAgreed override still works with default", () => {
  test("custom amount, 0 scholarship, and fallback all coexist after fix", async () => {
    // Default Tuition head with defaultAmount = 2000 (set in top-level beforeEach)
    setActiveStudents([
      { _id: "s1", name: "Custom", feeAgreed: "750" },    // custom
      { _id: "s2", name: "Scholar", feeAgreed: "0" },      // scholarship (0)
      { _id: "s3", name: "Default", feeAgreed: null },      // fallback to 2000
    ]);

    await generateMonthlyFeesService(ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(201);
    const insertedDocs = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedDocs).toHaveLength(3);

    const byStudent = {};
    insertedDocs.forEach((d) => { byStudent[d.student] = d.amount; });
    expect(byStudent["s1"]).toBe(750);
    expect(byStudent["s2"]).toBe(0);
    expect(byStudent["s3"]).toBe(DEFAULT_AMOUNT);
  });
});
