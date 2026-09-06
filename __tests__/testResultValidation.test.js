/**
 * Tests schema-level validation on the TestResult model's score field.
 *
 * Verifies:
 *   1. Negative scores are rejected by the min: 0 validator.
 *   2. Scores exceeding the Test's totalMarks are rejected by the async validator.
 *   3. Valid scores within [0, totalMarks] pass validation.
 *
 * No real database connection is needed — Test.findById is mocked so the
 * async validator runs without hitting MongoDB.
 */

const mongoose = require("mongoose");

// Require model files to register them with Mongoose.
// The Test model must be registered before the TestResult validator runs.
const Test = require("../models/Academic/test.model");
const TestResult = require("../models/Academic/testResult.model");

// Valid ObjectId strings for required ref fields
const TEST_ID = new mongoose.Types.ObjectId();
const STUDENT_ID = new mongoose.Types.ObjectId();
const TEACHER_ID = new mongoose.Types.ObjectId();

afterEach(() => {
  jest.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 1: Negative score — rejected by min: 0
// ═════════════════════════════════════════════════════════════════════════════
describe("TestResult schema – min: 0 validator", () => {
  test("rejects a negative score", async () => {
    const result = new TestResult({
      test: TEST_ID,
      student: STUDENT_ID,
      score: -1,
      markedBy: TEACHER_ID,
    });

    await expect(result.validate()).rejects.toThrow(
      mongoose.Error.ValidationError
    );

    try {
      await result.validate();
    } catch (err) {
      expect(err.errors.score).toBeDefined();
      expect(err.errors.score.message).toMatch(/cannot be negative/i);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 2: Score exceeds totalMarks — rejected by async validator
// ═════════════════════════════════════════════════════════════════════════════
describe("TestResult schema – totalMarks async validator", () => {
  test("rejects a score that exceeds the test's totalMarks", async () => {
    // Mock Test.findById to return a test with totalMarks = 50
    jest.spyOn(Test, "findById").mockResolvedValue({ totalMarks: 50 });

    const result = new TestResult({
      test: TEST_ID,
      student: STUDENT_ID,
      score: 51, // exceeds totalMarks
      markedBy: TEACHER_ID,
    });

    await expect(result.validate()).rejects.toThrow(
      mongoose.Error.ValidationError
    );

    try {
      await result.validate();
    } catch (err) {
      expect(err.errors.score).toBeDefined();
      expect(err.errors.score.message).toMatch(
        /cannot exceed the test's total marks/i
      );
    }
  });

  test("rejects when the referenced Test does not exist", async () => {
    // Mock Test.findById to return null (test not found)
    jest.spyOn(Test, "findById").mockResolvedValue(null);

    const result = new TestResult({
      test: TEST_ID,
      student: STUDENT_ID,
      score: 10,
      markedBy: TEACHER_ID,
    });

    await expect(result.validate()).rejects.toThrow(
      mongoose.Error.ValidationError
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 3: Valid score — passes validation
// ═════════════════════════════════════════════════════════════════════════════
describe("TestResult schema – valid score", () => {
  test("accepts a score within [0, totalMarks]", async () => {
    jest.spyOn(Test, "findById").mockResolvedValue({ totalMarks: 50 });

    const result = new TestResult({
      test: TEST_ID,
      student: STUDENT_ID,
      score: 42,
      markedBy: TEACHER_ID,
    });

    // Should not throw
    await expect(result.validate()).resolves.toBeUndefined();
  });

  test("accepts a score of exactly 0 (boundary)", async () => {
    jest.spyOn(Test, "findById").mockResolvedValue({ totalMarks: 50 });

    const result = new TestResult({
      test: TEST_ID,
      student: STUDENT_ID,
      score: 0,
      markedBy: TEACHER_ID,
    });

    await expect(result.validate()).resolves.toBeUndefined();
  });

  test("accepts a score equal to totalMarks (boundary)", async () => {
    jest.spyOn(Test, "findById").mockResolvedValue({ totalMarks: 50 });

    const result = new TestResult({
      test: TEST_ID,
      student: STUDENT_ID,
      score: 50,
      markedBy: TEACHER_ID,
    });

    await expect(result.validate()).resolves.toBeUndefined();
  });
});
