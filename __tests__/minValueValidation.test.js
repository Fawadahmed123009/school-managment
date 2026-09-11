/**
 * Tests schema-level min-value validation across multiple models and services.
 *
 * Verifies:
 *   1. Fees.amount rejects negative and zero values
 *   2. FeeHead.defaultAmount rejects negative values
 *   3. Test.totalMarks rejects values < 1
 *   4. Test.passMarks rejects negative values and values > totalMarks
 *   5. Student.rollNumber accepts alphanumeric strings
 *   6. bulkCreateFeesService rejects rows with invalid amounts
 */

const mongoose = require("mongoose");

// Require models to register them with Mongoose
const Fees = require("../models/Fees/fees.model");
const FeeHead = require("../models/Fees/feeHead.model");
const Test = require("../models/Academic/test.model");
const Student = require("../models/Students/students.model");

// Valid ObjectId strings for required ref fields
const ADMIN_ID = new mongoose.Types.ObjectId();
const STUDENT_ID = new mongoose.Types.ObjectId();

afterEach(() => {
  jest.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 1: Fees.amount validation
// ═════════════════════════════════════════════════════════════════════════════
describe("Fees schema – amount validation", () => {
  test("rejects a negative amount", async () => {
    const fee = new Fees({
      student: STUDENT_ID,
      amount: -100,
      recordedBy: ADMIN_ID,
    });

    await expect(fee.validate()).rejects.toThrow(mongoose.Error.ValidationError);

    try {
      await fee.validate();
    } catch (err) {
      expect(err.errors.amount).toBeDefined();
      expect(err.errors.amount.message).toMatch(/cannot be negative/i);
    }
  });

  test("rejects a zero amount", async () => {
    const fee = new Fees({
      student: STUDENT_ID,
      amount: 0,
      recordedBy: ADMIN_ID,
    });

    await expect(fee.validate()).rejects.toThrow(mongoose.Error.ValidationError);

    try {
      await fee.validate();
    } catch (err) {
      expect(err.errors.amount).toBeDefined();
      expect(err.errors.amount.message).toMatch(/must be greater than zero/i);
    }
  });

  test("accepts a positive amount", async () => {
    const fee = new Fees({
      student: STUDENT_ID,
      amount: 5000,
      recordedBy: ADMIN_ID,
    });

    await expect(fee.validate()).resolves.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 2: FeeHead.defaultAmount validation
// ═════════════════════════════════════════════════════════════════════════════
describe("FeeHead schema – defaultAmount validation", () => {
  test("rejects a negative defaultAmount", async () => {
    const feeHead = new FeeHead({
      name: "Tuition",
      defaultAmount: -500,
      createdBy: ADMIN_ID,
    });

    await expect(feeHead.validate()).rejects.toThrow(mongoose.Error.ValidationError);

    try {
      await feeHead.validate();
    } catch (err) {
      expect(err.errors.defaultAmount).toBeDefined();
      expect(err.errors.defaultAmount.message).toMatch(/cannot be negative/i);
    }
  });

  test("accepts a zero defaultAmount", async () => {
    const feeHead = new FeeHead({
      name: "Tuition",
      defaultAmount: 0,
      createdBy: ADMIN_ID,
    });

    await expect(feeHead.validate()).resolves.toBeUndefined();
  });

  test("accepts a positive defaultAmount", async () => {
    const feeHead = new FeeHead({
      name: "Tuition",
      defaultAmount: 5000,
      createdBy: ADMIN_ID,
    });

    await expect(feeHead.validate()).resolves.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 3: Test.totalMarks validation
// ═════════════════════════════════════════════════════════════════════════════
describe("Test schema – totalMarks validation", () => {
  test("rejects totalMarks less than 1", async () => {
    const test = new Test({
      name: "Midterm",
      subject: new mongoose.Types.ObjectId(),
      classLevels: [new mongoose.Types.ObjectId()],
      totalMarks: 0,
      passMarks: 0,
      createdBy: ADMIN_ID,
    });

    await expect(test.validate()).rejects.toThrow(mongoose.Error.ValidationError);

    try {
      await test.validate();
    } catch (err) {
      expect(err.errors.totalMarks).toBeDefined();
      expect(err.errors.totalMarks.message).toMatch(/must be at least 1/i);
    }
  });

  test("accepts totalMarks of 1", async () => {
    const test = new Test({
      name: "Midterm",
      subject: new mongoose.Types.ObjectId(),
      classLevels: [new mongoose.Types.ObjectId()],
      totalMarks: 1,
      passMarks: 0,
      createdBy: ADMIN_ID,
    });

    await expect(test.validate()).resolves.toBeUndefined();
  });

  test("accepts totalMarks greater than 1", async () => {
    const test = new Test({
      name: "Midterm",
      subject: new mongoose.Types.ObjectId(),
      classLevels: [new mongoose.Types.ObjectId()],
      totalMarks: 100,
      passMarks: 40,
      createdBy: ADMIN_ID,
    });

    await expect(test.validate()).resolves.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 4: Test.passMarks validation
// ═════════════════════════════════════════════════════════════════════════════
describe("Test schema – passMarks validation", () => {
  test("rejects negative passMarks", async () => {
    const test = new Test({
      name: "Midterm",
      subject: new mongoose.Types.ObjectId(),
      classLevels: [new mongoose.Types.ObjectId()],
      totalMarks: 100,
      passMarks: -10,
      createdBy: ADMIN_ID,
    });

    await expect(test.validate()).rejects.toThrow(mongoose.Error.ValidationError);

    try {
      await test.validate();
    } catch (err) {
      expect(err.errors.passMarks).toBeDefined();
      expect(err.errors.passMarks.message).toMatch(/cannot be negative/i);
    }
  });

  test("rejects passMarks greater than totalMarks", async () => {
    const test = new Test({
      name: "Midterm",
      subject: new mongoose.Types.ObjectId(),
      classLevels: [new mongoose.Types.ObjectId()],
      totalMarks: 50,
      passMarks: 60,
      createdBy: ADMIN_ID,
    });

    await expect(test.validate()).rejects.toThrow(mongoose.Error.ValidationError);

    try {
      await test.validate();
    } catch (err) {
      expect(err.errors.passMarks).toBeDefined();
      expect(err.errors.passMarks.message).toMatch(/cannot exceed total marks/i);
    }
  });

  test("accepts passMarks equal to totalMarks", async () => {
    const test = new Test({
      name: "Midterm",
      subject: new mongoose.Types.ObjectId(),
      classLevels: [new mongoose.Types.ObjectId()],
      totalMarks: 50,
      passMarks: 50,
      createdBy: ADMIN_ID,
    });

    await expect(test.validate()).resolves.toBeUndefined();
  });

  test("accepts passMarks less than totalMarks", async () => {
    const test = new Test({
      name: "Midterm",
      subject: new mongoose.Types.ObjectId(),
      classLevels: [new mongoose.Types.ObjectId()],
      totalMarks: 100,
      passMarks: 40,
      createdBy: ADMIN_ID,
    });

    await expect(test.validate()).resolves.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 5: Student.rollNumber validation
// ═════════════════════════════════════════════════════════════════════════════
describe("Student schema – rollNumber validation", () => {
  test("accepts numeric string rollNumber", async () => {
    const student = new Student({
      name: "John Doe",
      email: "john@example.com",
      password: "hashedpassword",
      rollNumber: "1",
      classLevel: new mongoose.Types.ObjectId(),
    });

    await expect(student.validate()).resolves.toBeUndefined();
  });

  test("accepts alphanumeric rollNumber", async () => {
    const student = new Student({
      name: "John Doe",
      email: "john@example.com",
      password: "hashedpassword",
      rollNumber: "9A-01",
      classLevel: new mongoose.Types.ObjectId(),
    });

    await expect(student.validate()).resolves.toBeUndefined();
  });

  test("accepts alphanumeric rollNumber with letters", async () => {
    const student = new Student({
      name: "John Doe",
      email: "john@example.com",
      password: "hashedpassword",
      rollNumber: "R23",
      classLevel: new mongoose.Types.ObjectId(),
    });

    await expect(student.validate()).resolves.toBeUndefined();
  });

  test("trims whitespace from rollNumber", async () => {
    const student = new Student({
      name: "John Doe",
      email: "john@example.com",
      password: "hashedpassword",
      rollNumber: "  9A-01  ",
      classLevel: new mongoose.Types.ObjectId(),
    });

    await expect(student.validate()).resolves.toBeUndefined();
    expect(student.rollNumber).toBe("9A-01");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 6: bulkCreateFeesService validation
// ═════════════════════════════════════════════════════════════════════════════
describe("bulkCreateFeesService – amount validation", () => {
  const mockInsertMany = jest.fn();
  const mockFind = jest.fn();
  const mockCreate = jest.fn();
  
  jest.mock("../models/Fees/fees.model", () => ({
    insertMany: (...args) => mockInsertMany(...args),
    find: (...args) => mockFind(...args),
    create: (...args) => mockCreate(...args),
  }));

  jest.mock("../models/Fees/feeHead.model", () => ({}));
  jest.mock("../models/Students/students.model", () => ({}));

  const { bulkCreateFeesService } = require("../services/fees/fees.service");

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

  test("rejects rows with negative amounts", async () => {
    const rows = [
      { student: STUDENT_ID, amount: -100 },
      { student: STUDENT_ID, amount: 500 },
    ];

    await bulkCreateFeesService(rows, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(fakeRes._body.message.message).toMatch(/invalid amounts/i);
    expect(fakeRes._body.message.invalidRows).toHaveLength(1);
    expect(fakeRes._body.message.invalidRows[0].reason).toMatch(/negative/i);
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  test("rejects rows with zero amounts", async () => {
    const rows = [
      { student: STUDENT_ID, amount: 0 },
      { student: STUDENT_ID, amount: 500 },
    ];

    await bulkCreateFeesService(rows, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(fakeRes._body.message.message).toMatch(/invalid amounts/i);
    expect(fakeRes._body.message.invalidRows).toHaveLength(1);
    expect(fakeRes._body.message.invalidRows[0].reason).toMatch(/zero/i);
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  test("rejects rows with null/missing amounts", async () => {
    const rows = [
      { student: STUDENT_ID, amount: null },
      { student: STUDENT_ID }, // missing amount
    ];

    await bulkCreateFeesService(rows, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(fakeRes._body.message.message).toMatch(/invalid amounts/i);
    expect(fakeRes._body.message.invalidRows).toHaveLength(2);
    expect(fakeRes._body.message.invalidRows[0].reason).toMatch(/null\/missing/i);
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  test("accepts rows with all valid positive amounts", async () => {
    const rows = [
      { student: STUDENT_ID, amount: 500 },
      { student: STUDENT_ID, amount: 1000 },
    ];

    // Mock Fees.find to return no pending fees (so new records are created)
    mockFind.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });
    mockCreate.mockResolvedValue([{ _id: "fee1" }, { _id: "fee2" }]);

    await bulkCreateFeesService(rows, ADMIN_ID, fakeRes);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(fakeRes._statusCode).toBe(201);
  });
});
