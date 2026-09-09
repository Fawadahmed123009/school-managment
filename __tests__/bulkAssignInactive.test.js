/**
 * Tests for bulkAssignFeesService — verifies that inactive, graduated,
 * and withdrawn students are excluded from bulk fee assignment, including
 * after the multi-class selection feature was added.
 *
 * Verifies that:
 *   • Inactive students (status: "inactive") are skipped.
 *   • Graduated students (isGraduated: true) are skipped.
 *   • Withdrawn students (isWithdrawn: true) are skipped.
 *   • Multi-class selection still respects all exclusions.
 *   • Active students in the same class are correctly assigned.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockStudentFind = jest.fn();
const mockFeeHeadFindById = jest.fn();
const mockFeesFind = jest.fn();
const mockFeesInsertMany = jest.fn();

jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
}));
jest.mock("../models/Fees/feeHead.model", () => ({
  findById: (...a) => mockFeeHeadFindById(...a),
}));
jest.mock("../models/Fees/fees.model", () => ({
  find: (...a) => mockFeesFind(...a),
  insertMany: (...a) => mockFeesInsertMany(...a),
}));

const { bulkAssignFeesService } = require("../services/fees/fees.service");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const ADMIN_ID = "admin-001";
const FEE_HEAD_ID = "feehead-tuition";
const CLASS_9A_ID = "cls-9a";
const CLASS_9B_ID = "cls-9b";

const FEE_HEAD = {
  _id: FEE_HEAD_ID,
  name: "Tuition",
  defaultAmount: 5000,
};

// Students in class 9A — mix of active, inactive, graduated, withdrawn
const ACTIVE_STUDENT_1 = { _id: "stu-active-1", name: "Active Student 1" };
const ACTIVE_STUDENT_2 = { _id: "stu-active-2", name: "Active Student 2" };
const INACTIVE_STUDENT = { _id: "stu-inactive", name: "Inactive Student" };
const GRADUATED_STUDENT = { _id: "stu-graduated", name: "Graduated Student" };
const WITHDRAWN_STUDENT = { _id: "stu-withdrawn", name: "Withdrawn Student" };

beforeEach(() => {
  jest.clearAllMocks();
  mockFeeHeadFindById.mockResolvedValue(FEE_HEAD);
  mockFeesFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });
  mockFeesInsertMany.mockImplementation(async (rows) => rows.map((r, i) => ({ _id: `fee-${i}`, ...r })));
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("bulkAssignFeesService — inactive/graduated/withdrawn exclusion", () => {
  test("excludes inactive students when assigning to a single class", async () => {
    // Student.find is called with the studentFilter.
    // We simulate the real DB behaviour: only active, non-graduated,
    // non-withdrawn students in the class should be returned.
    mockStudentFind.mockImplementation((filter) => {
      // Verify the filter contains the exclusion clauses
      expect(filter.status).toEqual({ $ne: "inactive" });
      expect(filter.isGraduated).toEqual({ $ne: true });
      expect(filter.isWithdrawn).toEqual({ $ne: true });
      expect(filter.classLevel).toEqual({ $in: [CLASS_9A_ID] });

      // Simulate DB result: only the 2 active students
      return { select: () => ({ lean: async () => [ACTIVE_STUDENT_1, ACTIVE_STUDENT_2] }) };
    });

    const res = mockRes();
    await bulkAssignFeesService(
      { feeHead: FEE_HEAD_ID, targetType: "class", classLevel: [CLASS_9A_ID] },
      ADMIN_ID,
      res,
    );

    // Verify insertMany was called with only active students
    expect(mockFeesInsertMany).toHaveBeenCalledTimes(1);
    const insertedRows = mockFeesInsertMany.mock.calls[0][0];
    const insertedStudentIds = insertedRows.map((r) => r.student);

    expect(insertedStudentIds).toContain("stu-active-1");
    expect(insertedStudentIds).toContain("stu-active-2");
    expect(insertedStudentIds).not.toContain("stu-inactive");
    expect(insertedStudentIds).not.toContain("stu-graduated");
    expect(insertedStudentIds).not.toContain("stu-withdrawn");
    expect(insertedRows).toHaveLength(2);
  });

  test("excludes inactive students when assigning to multiple classes", async () => {
    mockStudentFind.mockImplementation((filter) => {
      // Verify multi-class filter + exclusions
      expect(filter.status).toEqual({ $ne: "inactive" });
      expect(filter.isGraduated).toEqual({ $ne: true });
      expect(filter.isWithdrawn).toEqual({ $ne: true });
      expect(filter.classLevel).toEqual({ $in: [CLASS_9A_ID, CLASS_9B_ID] });

      // Simulate: 2 active in 9A, 1 active + 1 inactive in 9B
      return {
        select: () => ({
          lean: async () => [
            ACTIVE_STUDENT_1,
            ACTIVE_STUDENT_2,
            { _id: "stu-9b-active", name: "9B Active" },
            // The inactive student in 9B should NOT appear here because
            // the filter excludes status: "inactive"
          ],
        }),
      };
    });

    const res = mockRes();
    await bulkAssignFeesService(
      { feeHead: FEE_HEAD_ID, targetType: "class", classLevel: [CLASS_9A_ID, CLASS_9B_ID] },
      ADMIN_ID,
      res,
    );

    expect(mockFeesInsertMany).toHaveBeenCalledTimes(1);
    const insertedRows = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedRows).toHaveLength(3);

    const insertedIds = insertedRows.map((r) => r.student);
    expect(insertedIds).toContain("stu-active-1");
    expect(insertedIds).toContain("stu-active-2");
    expect(insertedIds).toContain("stu-9b-active");
    expect(insertedIds).not.toContain("stu-inactive");
  });

  test("excludes inactive when targetType is 'all'", async () => {
    mockStudentFind.mockImplementation((filter) => {
      // When targetType is "all", no classLevel filter, but exclusions remain
      expect(filter.status).toEqual({ $ne: "inactive" });
      expect(filter.isGraduated).toEqual({ $ne: true });
      expect(filter.isWithdrawn).toEqual({ $ne: true });
      expect(filter.classLevel).toBeUndefined();

      return { select: () => ({ lean: async () => [ACTIVE_STUDENT_1] }) };
    });

    const res = mockRes();
    await bulkAssignFeesService(
      { feeHead: FEE_HEAD_ID, targetType: "all" },
      ADMIN_ID,
      res,
    );

    const insertedRows = mockFeesInsertMany.mock.calls[0][0];
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].student).toBe("stu-active-1");
  });

  test("returns 404 when all students in class are inactive", async () => {
    // Simulate: the query returns zero students because all are inactive
    mockStudentFind.mockImplementation((filter) => {
      expect(filter.status).toEqual({ $ne: "inactive" });
      return { select: () => ({ lean: async () => [] }) };
    });

    const res = mockRes();
    await bulkAssignFeesService(
      { feeHead: FEE_HEAD_ID, targetType: "class", classLevel: [CLASS_9A_ID] },
      ADMIN_ID,
      res,
    );

    // Should return 404 — no eligible students
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockFeesInsertMany).not.toHaveBeenCalled();
  });

  test("filter object is built correctly — all three exclusions present alongside $in class filter", async () => {
    // This is the key regression test: capture the exact filter passed to Student.find
    let capturedFilter = null;
    mockStudentFind.mockImplementation((filter) => {
      capturedFilter = filter;
      return { select: () => ({ lean: async () => [ACTIVE_STUDENT_1] }) };
    });

    const res = mockRes();
    await bulkAssignFeesService(
      { feeHead: FEE_HEAD_ID, targetType: "class", classLevel: [CLASS_9A_ID, CLASS_9B_ID] },
      ADMIN_ID,
      res,
    );

    // Confirm the filter has ALL four expected keys
    expect(capturedFilter).not.toBeNull();
    expect(capturedFilter.status).toEqual({ $ne: "inactive" });
    expect(capturedFilter.isGraduated).toEqual({ $ne: true });
    expect(capturedFilter.isWithdrawn).toEqual({ $ne: true });
    expect(capturedFilter.classLevel).toEqual({ $in: [CLASS_9A_ID, CLASS_9B_ID] });

    // Confirm there are no unexpected keys that might overwrite the exclusions
    const keys = Object.keys(capturedFilter).sort();
    expect(keys).toEqual(["classLevel", "isGraduated", "isWithdrawn", "status"]);
  });
});
