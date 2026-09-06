/**
 * Tests for batch assignment creation — the service that creates one Assignment
 * document per {teacher, subject, classLevel} combination when an admin selects
 * multiple class sections at once.
 *
 * Verifies that:
 *   • Selecting 4 sections across 2 grades creates 4 Assignment documents.
 *   • Duplicate {teacher, subject, classLevel} combos are skipped, not errored.
 *   • Subject appliesTo validation rejects classes the subject isn't taught in.
 *   • Empty classLevels array is rejected.
 *   • Mixed scenario: some created, some skipped, some invalid → correct counts.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockSubjectFindById = jest.fn();
const mockClassLevelFind = jest.fn();
const mockAssignmentFindOne = jest.fn();
const mockAssignmentCreate = jest.fn();

jest.mock("../models/Academic/subject.model", () => ({
  findById: (...a) => mockSubjectFindById(...a),
}));
jest.mock("../models/Academic/class.model", () => ({
  find: (...a) => mockClassLevelFind(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  findOne: (...a) => mockAssignmentFindOne(...a),
  create: (...a) => mockAssignmentCreate(...a),
}));

const { createBatchAssignmentService } = require("../services/academic/assignment.service");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const ADMIN_ID = "admin-001";
const TEACHER_ID = "teacher-001";
const SUBJECT_ID = "sub-math";

// 4 class levels across 2 grades
const CLASS_9A = { _id: "cls-9a", name: "Grade 9-A", gradeLevel: "9", group: null, section: "Boys" };
const CLASS_9B = { _id: "cls-9b", name: "Grade 9-B", gradeLevel: "9", group: null, section: "Girls" };
const CLASS_10A = { _id: "cls-10a", name: "Grade 10-A", gradeLevel: "10", group: "Science", section: "Boys" };
const CLASS_10B = { _id: "cls-10b", name: "Grade 10-B", gradeLevel: "10", group: "Science", section: "Girls" };

// Subject that applies to all 4 classes via wholeGrade
const SUBJECT_WHOLE_GRADE = {
  _id: SUBJECT_ID,
  name: "Mathematics",
  appliesTo: [
    { gradeLevel: "9", required: true },
    { gradeLevel: "10", required: true },
  ],
};

// Subject that only applies to specific classes
const SUBJECT_SPECIFIC = {
  _id: "sub-phys",
  name: "Physics",
  appliesTo: [
    { classLevel: "cls-9a", required: true },
    { classLevel: "cls-10a", required: true },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAssignmentCreate.mockImplementation(async (doc) => ({ _id: `assign-${Math.random().toString(36).slice(2, 8)}`, ...doc }));
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createBatchAssignmentService", () => {
  test("creates 4 Assignment documents for 4 sections across 2 grades", async () => {
    const classLevels = [CLASS_9A._id, CLASS_9B._id, CLASS_10A._id, CLASS_10B._id];

    mockSubjectFindById.mockResolvedValue(SUBJECT_WHOLE_GRADE);
    mockClassLevelFind.mockResolvedValue([CLASS_9A, CLASS_9B, CLASS_10A, CLASS_10B]);
    // No existing assignments
    mockAssignmentFindOne.mockResolvedValue(null);

    const res = mockRes();
    await createBatchAssignmentService({ teacher: TEACHER_ID, subject: SUBJECT_ID, classLevels }, ADMIN_ID, res);

    // Verify 4 assignments were created
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(4);
    // Verify the response
    expect(res.status).toHaveBeenCalledWith(201);
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.status).toBe("success");
    expect(jsonArg.data.created).toBe(4);
    expect(jsonArg.data.skipped).toBe(0);
    expect(jsonArg.data.errors).toHaveLength(0);
  });

  test("skips duplicate assignments without erroring the whole batch", async () => {
    const classLevels = [CLASS_9A._id, CLASS_9B._id];

    mockSubjectFindById.mockResolvedValue(SUBJECT_WHOLE_GRADE);
    mockClassLevelFind.mockResolvedValue([CLASS_9A, CLASS_9B]);
    // First class already assigned, second is new
    mockAssignmentFindOne
      .mockResolvedValueOnce({ _id: "existing-1" }) // 9A already exists
      .mockResolvedValueOnce(null); // 9B is new

    const res = mockRes();
    await createBatchAssignmentService({ teacher: TEACHER_ID, subject: SUBJECT_ID, classLevels }, ADMIN_ID, res);

    // Only 1 new assignment created (9B), 1 skipped (9A)
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.data.created).toBe(1);
    expect(jsonArg.data.skipped).toBe(1);
  });

  test("rejects classes where the subject doesn't apply (appliesTo validation)", async () => {
    // Physics only applies to 9A and 10A, not 9B or 10B
    const classLevels = [CLASS_9A._id, CLASS_9B._id, CLASS_10A._id, CLASS_10B._id];

    mockSubjectFindById.mockResolvedValue(SUBJECT_SPECIFIC);
    mockClassLevelFind.mockResolvedValue([CLASS_9A, CLASS_9B, CLASS_10A, CLASS_10B]);
    mockAssignmentFindOne.mockResolvedValue(null);

    const res = mockRes();
    await createBatchAssignmentService({ teacher: TEACHER_ID, subject: "sub-phys", classLevels }, ADMIN_ID, res);

    // Only 2 created (9A and 10A), 2 errors (9B and 10B don't match appliesTo)
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(2);
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.data.created).toBe(2);
    expect(jsonArg.data.errors).toHaveLength(2);
  });

  test("rejects with 400 when no classLevels are provided", async () => {
    const res = mockRes();
    await createBatchAssignmentService({ teacher: TEACHER_ID, subject: SUBJECT_ID, classLevels: [] }, ADMIN_ID, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test("rejects with 404 when subject doesn't exist", async () => {
    mockSubjectFindById.mockResolvedValue(null);

    const res = mockRes();
    await createBatchAssignmentService({ teacher: TEACHER_ID, subject: "nonexistent", classLevels: [CLASS_9A._id] }, ADMIN_ID, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test("mixed scenario: some created, some skipped, some invalid", async () => {
    // Physics applies to 9A and 10A only.
    // 9A already assigned (skip), 10A is new (create), 9B invalid, 10B invalid
    const classLevels = [CLASS_9A._id, CLASS_10A._id, CLASS_9B._id, CLASS_10B._id];

    mockSubjectFindById.mockResolvedValue(SUBJECT_SPECIFIC);
    mockClassLevelFind.mockResolvedValue([CLASS_9A, CLASS_10A, CLASS_9B, CLASS_10B]);
    mockAssignmentFindOne
      .mockResolvedValueOnce({ _id: "existing-9a" }) // 9A exists
      .mockResolvedValueOnce(null); // 10A is new

    const res = mockRes();
    await createBatchAssignmentService({ teacher: TEACHER_ID, subject: "sub-phys", classLevels }, ADMIN_ID, res);

    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.data.created).toBe(1);
    expect(jsonArg.data.skipped).toBe(1);
    expect(jsonArg.data.errors).toHaveLength(2);
  });

  test("returns 400 when ALL classes are invalid (none created)", async () => {
    // Physics applies only to 9A and 10A, but we only send 9B and 10B
    const classLevels = [CLASS_9B._id, CLASS_10B._id];

    mockSubjectFindById.mockResolvedValue(SUBJECT_SPECIFIC);
    mockClassLevelFind.mockResolvedValue([CLASS_9B, CLASS_10B]);

    const res = mockRes();
    await createBatchAssignmentService({ teacher: TEACHER_ID, subject: "sub-phys", classLevels }, ADMIN_ID, res);

    expect(mockAssignmentCreate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.status).toBe("failed");
    expect(jsonArg.message).toContain("not taught in");
  });
});
