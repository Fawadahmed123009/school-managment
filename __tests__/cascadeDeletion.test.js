/**
 * Cascade / Block deletion tests for Teacher, ClassLevel, Subject, and Program.
 *
 * Each model gets tests for:
 *   1. BLOCK case  – real blocking condition present → rejected with correct error
 *   2. CASCADE case – no blocking condition → deletion succeeds and cleanup
 *      actually happened (cascade-deleted records are gone, pulled array entries
 *      are actually removed, nulled fields are actually null).
 *
 * All models are mocked at the data layer so the real service logic executes
 * without a database.
 */

// ── Shared mock res factory ──────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ── Unified model mocks (all methods any service might call) ─────────────────

// Teacher
const mockTeacherFindById = jest.fn();
const mockTeacherFindByIdAndDelete = jest.fn();

// Admin
const mockAdminFindByIdAndUpdate = jest.fn();

// Assignment
const mockAssignmentDeleteMany = jest.fn();

// TestResult
const mockTestResultUpdateMany = jest.fn();

// Attendance
const mockAttendanceUpdateMany = jest.fn();

// ClassLevel
const mockClassLevelFindById = jest.fn();
const mockClassLevelFindByIdAndDelete = jest.fn();

// Student
const mockStudentCountDocuments = jest.fn();

// Subject
const mockSubjectFindById = jest.fn();
const mockSubjectFindByIdAndDelete = jest.fn();
const mockSubjectUpdateMany = jest.fn();
const mockSubjectCountDocuments = jest.fn();

// Test
const mockTestCountDocuments = jest.fn();
const mockTestUpdateMany = jest.fn();

// Program
const mockProgramFindById = jest.fn();
const mockProgramFindByIdAndDelete = jest.fn();
const mockProgramUpdateMany = jest.fn();

jest.mock("../models/Staff/teachers.model", () => ({
  findById: (...a) => mockTeacherFindById(...a),
  findByIdAndDelete: (...a) => mockTeacherFindByIdAndDelete(...a),
}));

jest.mock("../models/Staff/admin.model", () => ({
  findByIdAndUpdate: (...a) => mockAdminFindByIdAndUpdate(...a),
}));

jest.mock("../models/Academic/assignment.model", () => ({
  deleteMany: (...a) => mockAssignmentDeleteMany(...a),
}));

jest.mock("../models/Academic/testResult.model", () => ({
  updateMany: (...a) => mockTestResultUpdateMany(...a),
}));

jest.mock("../models/Academic/attendance.model", () => ({
  updateMany: (...a) => mockAttendanceUpdateMany(...a),
}));

jest.mock("../models/Academic/class.model", () => ({
  findById: (...a) => mockClassLevelFindById(...a),
  findByIdAndDelete: (...a) => mockClassLevelFindByIdAndDelete(...a),
  find: jest.fn().mockResolvedValue([]),
}));

jest.mock("../models/Students/students.model", () => ({
  countDocuments: (...a) => mockStudentCountDocuments(...a),
  aggregate: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
}));

jest.mock("../models/Academic/subject.model", () => ({
  findById: (...a) => mockSubjectFindById(...a),
  findByIdAndDelete: (...a) => mockSubjectFindByIdAndDelete(...a),
  updateMany: (...a) => mockSubjectUpdateMany(...a),
  countDocuments: (...a) => mockSubjectCountDocuments(...a),
  findOne: jest.fn(),
  create: jest.fn(),
}));

jest.mock("../models/Academic/test.model", () => ({
  countDocuments: (...a) => mockTestCountDocuments(...a),
  updateMany: (...a) => mockTestUpdateMany(...a),
}));

jest.mock("../models/Academic/program.model", () => ({
  findById: (...a) => mockProgramFindById(...a),
  findByIdAndDelete: (...a) => mockProgramFindByIdAndDelete(...a),
  updateMany: (...a) => mockProgramUpdateMany(...a),
}));

// ── Require services AFTER mocks ─────────────────────────────────────────────
const { deleteTeacherService } = require("../services/staff/teachers.service");
const { deleteClassLevelService } = require("../services/academic/class.service");
const { deleteSubjectService } = require("../services/academic/subject.service");
const { deleteProgramService } = require("../services/academic/program.service");

// ── Shared IDs ───────────────────────────────────────────────────────────────
const TEACHER_ID = "teacher-del-1";
const CLASS_ID = "class-del-1";
const SUBJECT_ID = "subject-del-1";
const PROGRAM_ID = "program-del-1";

beforeEach(() => jest.clearAllMocks());

// ═══════════════════════════════════════════════════════════════════════════════
// 1. TEACHER DELETION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Teacher Deletion — Cascade Cleanup", () => {
  test("CASCADE: deletes assignments, nulls markedBy fields, then deletes teacher", async () => {
    mockTeacherFindById.mockResolvedValue({ _id: TEACHER_ID, createdBy: "admin-1" });
    mockAssignmentDeleteMany.mockResolvedValue({ deletedCount: 3 });
    mockTestResultUpdateMany.mockResolvedValue({ modifiedCount: 5 });
    mockAttendanceUpdateMany.mockResolvedValue({ modifiedCount: 10 });
    mockAdminFindByIdAndUpdate.mockResolvedValue({});
    mockTeacherFindByIdAndDelete.mockResolvedValue({ _id: TEACHER_ID });

    const res = mockRes();
    await deleteTeacherService(TEACHER_ID, res);

    expect(res.status).toHaveBeenCalledWith(200);

    // Assignments referencing this teacher were cascade-deleted
    expect(mockAssignmentDeleteMany).toHaveBeenCalledWith({ teacher: TEACHER_ID });

    // TestResult.markedBy was nulled (not deleted — history preserved)
    expect(mockTestResultUpdateMany).toHaveBeenCalledWith(
      { markedBy: TEACHER_ID },
      { $set: { markedBy: null } }
    );

    // Attendance.markedBy was nulled (not deleted — history preserved)
    expect(mockAttendanceUpdateMany).toHaveBeenCalledWith(
      { markedBy: TEACHER_ID },
      { $set: { markedBy: null } }
    );

    // Teacher was actually deleted
    expect(mockTeacherFindByIdAndDelete).toHaveBeenCalledWith(TEACHER_ID);
  });

  test("CASCADE: runs even when no related records exist (zero counts)", async () => {
    mockTeacherFindById.mockResolvedValue({ _id: TEACHER_ID, createdBy: "admin-1" });
    mockAssignmentDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockTestResultUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockAttendanceUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockAdminFindByIdAndUpdate.mockResolvedValue({});
    mockTeacherFindByIdAndDelete.mockResolvedValue({ _id: TEACHER_ID });

    const res = mockRes();
    await deleteTeacherService(TEACHER_ID, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // All cascade operations were still called
    expect(mockAssignmentDeleteMany).toHaveBeenCalledWith({ teacher: TEACHER_ID });
    expect(mockTestResultUpdateMany).toHaveBeenCalledWith(
      { markedBy: TEACHER_ID },
      { $set: { markedBy: null } }
    );
    expect(mockAttendanceUpdateMany).toHaveBeenCalledWith(
      { markedBy: TEACHER_ID },
      { $set: { markedBy: null } }
    );
    expect(mockTeacherFindByIdAndDelete).toHaveBeenCalledWith(TEACHER_ID);
  });

  test("returns 404 when teacher not found", async () => {
    mockTeacherFindById.mockResolvedValue(null);

    const res = mockRes();
    await deleteTeacherService("nonexistent-id", res);

    expect(res.status).toHaveBeenCalledWith(404);
    // No cascade operations should run
    expect(mockAssignmentDeleteMany).not.toHaveBeenCalled();
    expect(mockTestResultUpdateMany).not.toHaveBeenCalled();
    expect(mockAttendanceUpdateMany).not.toHaveBeenCalled();
    expect(mockTeacherFindByIdAndDelete).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CLASSLEVEL DELETION
// ═══════════════════════════════════════════════════════════════════════════════

describe("ClassLevel Deletion — Block + Cascade", () => {
  test("BLOCK: rejects deletion when students are enrolled", async () => {
    mockClassLevelFindById.mockResolvedValue({ _id: CLASS_ID, name: "Grade 5-A" });
    mockStudentCountDocuments.mockResolvedValue(3);

    const res = mockRes();
    await deleteClassLevelService(CLASS_ID, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toMatch(/3 student\(s\)/);

    // No cascade operations should run
    expect(mockAssignmentDeleteMany).not.toHaveBeenCalled();
    expect(mockSubjectUpdateMany).not.toHaveBeenCalled();
    expect(mockTestUpdateMany).not.toHaveBeenCalled();
    expect(mockClassLevelFindByIdAndDelete).not.toHaveBeenCalled();
  });

  test("CASCADE: deletes assignments, pulls from Subject.appliesTo and Test.classLevels, then deletes", async () => {
    mockClassLevelFindById.mockResolvedValue({ _id: CLASS_ID, name: "Grade 5-A" });
    mockStudentCountDocuments.mockResolvedValue(0);
    mockAssignmentDeleteMany.mockResolvedValue({ deletedCount: 2 });
    mockSubjectUpdateMany.mockResolvedValue({ modifiedCount: 3 });
    mockTestUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    mockClassLevelFindByIdAndDelete.mockResolvedValue({ _id: CLASS_ID });

    const res = mockRes();
    await deleteClassLevelService(CLASS_ID, res);

    expect(res.status).toHaveBeenCalledWith(200);

    // Assignments referencing this classLevel were cascade-deleted
    expect(mockAssignmentDeleteMany).toHaveBeenCalledWith({ classLevel: CLASS_ID });

    // Subject.appliesTo.classLevel was pulled
    expect(mockSubjectUpdateMany).toHaveBeenCalledWith(
      { "appliesTo.classLevel": CLASS_ID },
      { $pull: { appliesTo: { classLevel: CLASS_ID } } }
    );

    // Test.classLevels was pulled
    expect(mockTestUpdateMany).toHaveBeenCalledWith(
      { classLevels: CLASS_ID },
      { $pull: { classLevels: CLASS_ID } }
    );

    // ClassLevel was actually deleted
    expect(mockClassLevelFindByIdAndDelete).toHaveBeenCalledWith(CLASS_ID);
  });

  test("CASCADE: runs even when no related records exist (zero counts)", async () => {
    mockClassLevelFindById.mockResolvedValue({ _id: CLASS_ID, name: "Grade 5-A" });
    mockStudentCountDocuments.mockResolvedValue(0);
    mockAssignmentDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockSubjectUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockTestUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockClassLevelFindByIdAndDelete.mockResolvedValue({ _id: CLASS_ID });

    const res = mockRes();
    await deleteClassLevelService(CLASS_ID, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // All cascade operations were still called
    expect(mockAssignmentDeleteMany).toHaveBeenCalledWith({ classLevel: CLASS_ID });
    expect(mockSubjectUpdateMany).toHaveBeenCalledWith(
      { "appliesTo.classLevel": CLASS_ID },
      { $pull: { appliesTo: { classLevel: CLASS_ID } } }
    );
    expect(mockTestUpdateMany).toHaveBeenCalledWith(
      { classLevels: CLASS_ID },
      { $pull: { classLevels: CLASS_ID } }
    );
    expect(mockClassLevelFindByIdAndDelete).toHaveBeenCalledWith(CLASS_ID);
  });

  test("returns 404 when classLevel not found", async () => {
    mockClassLevelFindById.mockResolvedValue(null);

    const res = mockRes();
    await deleteClassLevelService("nonexistent-id", res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockClassLevelFindByIdAndDelete).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SUBJECT DELETION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Subject Deletion — Block + Cascade", () => {
  test("BLOCK: rejects deletion when tests reference this subject", async () => {
    mockSubjectFindById.mockResolvedValue({ _id: SUBJECT_ID, name: "Math" });
    mockTestCountDocuments.mockResolvedValue(5);

    const res = mockRes();
    await deleteSubjectService(SUBJECT_ID, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toMatch(/5 test\(s\)/);

    // No cascade operations should run
    expect(mockAssignmentDeleteMany).not.toHaveBeenCalled();
    expect(mockSubjectFindByIdAndDelete).not.toHaveBeenCalled();
    expect(mockProgramUpdateMany).not.toHaveBeenCalled();
  });

  test("CASCADE: deletes assignments, deletes subject, pulls from Program.subjects", async () => {
    mockSubjectFindById.mockResolvedValue({ _id: SUBJECT_ID, name: "Math" });
    mockTestCountDocuments.mockResolvedValue(0);
    mockAssignmentDeleteMany.mockResolvedValue({ deletedCount: 4 });
    mockSubjectFindByIdAndDelete.mockResolvedValue({ _id: SUBJECT_ID });
    mockProgramUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    const res = mockRes();
    await deleteSubjectService(SUBJECT_ID, res);

    expect(res.status).toHaveBeenCalledWith(200);

    // Assignments referencing this subject were cascade-deleted
    expect(mockAssignmentDeleteMany).toHaveBeenCalledWith({ subject: SUBJECT_ID });

    // Subject was actually deleted
    expect(mockSubjectFindByIdAndDelete).toHaveBeenCalledWith(SUBJECT_ID);

    // Program.subjects was pulled
    expect(mockProgramUpdateMany).toHaveBeenCalledWith(
      { subjects: SUBJECT_ID },
      { $pull: { subjects: SUBJECT_ID } }
    );
  });

  test("returns 404 when subject not found", async () => {
    mockSubjectFindById.mockResolvedValue(null);

    const res = mockRes();
    await deleteSubjectService("nonexistent-id", res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockSubjectFindByIdAndDelete).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PROGRAM DELETION
// ═══════════════════════════════════════════════════════════════════════════════

describe("Program Deletion — Block", () => {
  test("BLOCK: rejects deletion when subjects still belong to this program", async () => {
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_ID, name: "Matric" });
    mockSubjectCountDocuments.mockResolvedValue(4);

    const res = mockRes();
    await deleteProgramService(PROGRAM_ID, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toMatch(/4 subject\(s\)/);

    // Program should NOT be deleted
    expect(mockProgramFindByIdAndDelete).not.toHaveBeenCalled();
  });

  test("ALLOWED: deletes program when no subjects belong to it", async () => {
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_ID, name: "Matric" });
    mockSubjectCountDocuments.mockResolvedValue(0);
    mockProgramFindByIdAndDelete.mockResolvedValue({ _id: PROGRAM_ID });

    const res = mockRes();
    await deleteProgramService(PROGRAM_ID, res);

    expect(res.status).toHaveBeenCalledWith(200);

    // Program was actually deleted
    expect(mockProgramFindByIdAndDelete).toHaveBeenCalledWith(PROGRAM_ID);
  });

  test("returns 404 when program not found", async () => {
    mockProgramFindById.mockResolvedValue(null);

    const res = mockRes();
    await deleteProgramService("nonexistent-id", res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockProgramFindByIdAndDelete).not.toHaveBeenCalled();
  });
});
