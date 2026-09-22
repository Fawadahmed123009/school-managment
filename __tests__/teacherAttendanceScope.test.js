/**
 * Tests that the teacher attendance viewing service is properly scoped:
 *
 * - Teacher assigned to Class A only cannot see Class B attendance.
 * - Date range filter is applied correctly.
 * - Class filter rejects a class not in the assignment set (403).
 * - Teacher with no assignments gets empty result.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockAssignmentDistinct = jest.fn();
const mockClassLevelFind = jest.fn();
const mockAttendanceAggregate = jest.fn();
const mockStudentFind = jest.fn();

jest.mock("../models/Academic/assignment.model", () => ({
  distinct: (...a) => mockAssignmentDistinct(...a),
}));
jest.mock("../models/Academic/class.model", () => ({
  find: (...a) => mockClassLevelFind(...a),
}));
jest.mock("../models/Academic/attendance.model", () => ({
  aggregate: (...a) => mockAttendanceAggregate(...a),
}));
jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
}));

const { getTeacherAttendanceService } = require("../services/academic/attendance.service");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CLASS_A = "507f1f77bcf86cd799439011";
const CLASS_B = "507f1f77bcf86cd799439022";
const TEACHER_ASSIGNED = "teacher-assigned";
const TEACHER_UNASSIGNED = "teacher-none";

const STUDENTS_A = [
  { _id: "s1", name: "Student One", studentId: "STU-1", rollNumber: "1", classLevel: { _id: CLASS_A, name: "Class A" } },
  { _id: "s2", name: "Student Two", studentId: "STU-2", rollNumber: "2", classLevel: { _id: CLASS_A, name: "Class A" } },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function setupAssignmentMock(teacherId, classLevels) {
  mockAssignmentDistinct.mockImplementation((field, query) => {
    if (query && query.teacher === teacherId) {
      return Promise.resolve(classLevels);
    }
    return Promise.resolve([]);
  });
}

function setupClassLevelFind(classes) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockResolvedValue(classes),
  };
  mockClassLevelFind.mockReturnValue(chain);
}

function setupAttendanceAggregate(results) {
  mockAttendanceAggregate.mockResolvedValue(results);
}

function setupStudentFind(students) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(students),
  };
  mockStudentFind.mockReturnValue(chain);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────
describe("getTeacherAttendanceService — assignment scoping", () => {
  test("teacher assigned to Class A only sees Class A data, not Class B", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_ASSIGNED, [CLASS_A]);
    setupClassLevelFind([{ _id: CLASS_A, name: "Class A" }]);
    // scope "myClasses" only runs the perClass aggregation
    setupAttendanceAggregate([{ _id: CLASS_A, present: 15, absent: 2, late: 1 }]);

    await getTeacherAttendanceService(TEACHER_ASSIGNED, {
      startDate: "2025-09-01", endDate: "2025-09-30", scope: "myClasses",
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.data.perClass).toHaveLength(1);
    expect(body.data.perClass[0].className).toBe("Class A");
  });

  test("class filter rejects class not in assignment set (403)", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_ASSIGNED, [CLASS_A]);

    await getTeacherAttendanceService(TEACHER_ASSIGNED, {
      classLevel: CLASS_B, startDate: "2025-09-01", endDate: "2025-09-30", scope: "myClasses",
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/not assigned/i);
  });

  test("teacher with no assignments gets empty result", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_UNASSIGNED, []);

    await getTeacherAttendanceService(TEACHER_UNASSIGNED, {
      startDate: "2025-09-01", endDate: "2025-09-30", scope: "myClasses",
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.data.classes).toEqual([]);
    expect(body.data.perClass).toEqual([]);
    expect(body.data.perStudent).toEqual([]);
    expect(body.data.dailyTrend).toEqual([]);
    expect(body.data.studentHistory).toBeNull();
  });

  test("date range is passed to the aggregation match stage", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_ASSIGNED, [CLASS_A]);
    setupClassLevelFind([{ _id: CLASS_A, name: "Class A" }]);
    setupAttendanceAggregate([{ _id: CLASS_A, present: 10, absent: 0, late: 0 }]);

    await getTeacherAttendanceService(TEACHER_ASSIGNED, {
      startDate: "2025-03-01", endDate: "2025-03-31", scope: "myClasses",
    }, res);

    // Check that the aggregation was called with the correct date range
    const firstCallArgs = mockAttendanceAggregate.mock.calls[0][0];
    const matchStage = firstCallArgs[0].$match;
    expect(matchStage.date.$gte).toEqual(new Date(2025, 2, 1));  // March 1
    expect(matchStage.date.$lt).toEqual(new Date(2025, 3, 1));   // April 1 (March 31 + 1 day)
  });

  test("scope 'specificStudent' does NOT run perClass aggregation", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_ASSIGNED, [CLASS_A]);
    setupClassLevelFind([{ _id: CLASS_A, name: "Class A" }]);
    setupStudentFind(STUDENTS_A);
    // Only the per-student aggregation should fire
    mockAttendanceAggregate.mockResolvedValue([
      { _id: "s1", present: 8, absent: 1, late: 0 },
      { _id: "s2", present: 7, absent: 1, late: 1 },
    ]);

    await getTeacherAttendanceService(TEACHER_ASSIGNED, {
      startDate: "2025-09-01", endDate: "2025-09-30", scope: "specificStudent",
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.data.perClass).toEqual([]);
    expect(body.data.perStudent).toHaveLength(2);
    // Only one aggregate call was made (per-student), not two
    expect(mockAttendanceAggregate).toHaveBeenCalledTimes(1);
  });
});
