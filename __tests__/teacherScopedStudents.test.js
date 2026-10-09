/**
 * Tests for the unified PDF-report filter cascade's shared student source.
 *
 * GET /pdf-reports/teacher-students feeds the Student picker of ALL three
 * report panels (Result Sheet, Session Report Card, Analytics), so its scoping
 * IS the role scoping of the whole page:
 *   • admin / manager → the whole roster (no assignment lookup),
 *   • plain teacher   → only pupils enrolled in their assigned class levels.
 * Identity comes from the database (resolveCaller), never from token claims —
 * a bare token with no DB backing must fall into the restricted branch.
 */

const mockAssignmentLean = jest.fn();
const mockStudentLean = jest.fn();
const mockAdminLean = jest.fn();
const mockTeacherLean = jest.fn();

jest.mock("../models/Academic/assignment.model", () => ({
  // Controller chains find({teacher}).select("classLevel").lean().
  find: jest.fn(() => ({ select: () => ({ lean: () => mockAssignmentLean() }) })),
  findOne: jest.fn(),
}));
jest.mock("../models/Students/students.model", () => ({
  // Controller chains find(filter).select().populate().sort().lean().
  find: jest.fn(() => ({ select: () => ({ populate: () => ({ sort: () => ({ lean: () => mockStudentLean() }) }) }) })),
  findById: jest.fn(),
}));
jest.mock("../models/Academic/test.model", () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock("../models/Academic/testSession.model", () => ({ findById: jest.fn() }));
jest.mock("../models/Academic/class.model", () => ({ find: jest.fn() }));
jest.mock("../models/Academic/subject.model", () => ({ find: jest.fn() }));
jest.mock("../models/Academic/week.model", () => ({ find: jest.fn() }));

// Identity resolves from the DB: default "unknown caller" so a bare token
// exercises the restricted branch.
jest.mock("../models/Staff/admin.model", () => ({
  findById: () => ({ select: () => ({ lean: () => mockAdminLean() }) }),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  findById: () => ({ select: () => ({ lean: () => mockTeacherLean() }) }),
}));

jest.mock("../services/academic/pdfReport.service", () => ({ getPdfPath: jest.fn() }));

jest.mock("../handlers/responseStatus.handler", () =>
  jest.fn((res, status, statusText, data) => {
    res.status(status).json(statusText === "success" ? { status: statusText, data } : { status: statusText, message: data });
  })
);

const Assignment = require("../models/Academic/assignment.model");
const Student = require("../models/Students/students.model");
const { getTeacherScopedStudents } = require("../controllers/academic/pdfReport.controller");

const CLASS_9A = "507f1f77bcf86cd799439033";
const CLASS_10B = "507f1f77bcf86cd799439044";

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const ADMIN = { id: "admin-1", role: "admin" };
const MANAGER = { id: "manager-1", role: "teacher", isManager: true };
const TEACHER = { id: "teacher-1", role: "teacher" };

beforeEach(() => {
  jest.clearAllMocks();
  mockAdminLean.mockResolvedValue(null);
  mockTeacherLean.mockResolvedValue({ isAttendanceManager: false });
});

describe("teacher-scoped students — restricted branch (plain teacher)", () => {
  test("queries only enrolled pupils of the teacher's assigned classes", async () => {
    mockAssignmentLean.mockResolvedValue([
      { classLevel: CLASS_9A },
      { classLevel: CLASS_10B },
      { classLevel: CLASS_9A }, // duplicate assignment → ids must dedupe
      { classLevel: null },      // unassigned row must be ignored
    ]);
    mockStudentLean.mockResolvedValue([]);

    const res = mockRes();
    await getTeacherScopedStudents({ userAuth: TEACHER }, res);

    expect(Assignment.find).toHaveBeenCalledWith({ teacher: "teacher-1" });
    expect(Student.find.mock.calls[0][0]).toEqual({
      classLevel: { $in: [CLASS_9A, CLASS_10B] },
      status: "active",
      isWithdrawn: false,
      isGraduated: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("teacher with no assignments → empty list, roster never queried", async () => {
    mockAssignmentLean.mockResolvedValue([]);

    const res = mockRes();
    await getTeacherScopedStudents({ userAuth: TEACHER }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.students).toEqual([]);
    expect(Student.find).not.toHaveBeenCalled();
  });

  test("DB-derived manager is unrestricted even with a bare token", async () => {
    // Token claims nothing; resolveCaller must read isAttendanceManager from DB.
    mockTeacherLean.mockResolvedValue({ isAttendanceManager: true });
    mockStudentLean.mockResolvedValue([]);

    const res = mockRes();
    await getTeacherScopedStudents({ userAuth: { id: "manager-1" } }, res);

    expect(Student.find.mock.calls[0][0]).toEqual({});                 // whole roster
    expect(Assignment.find).not.toHaveBeenCalled();                    // no assignment scoping
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("teacher-scoped students — unrestricted branch (admin / manager)", () => {
  test("admin and manager get the whole roster with no assignment lookup", async () => {
    for (const user of [ADMIN, MANAGER]) {
      jest.clearAllMocks();
      mockStudentLean.mockResolvedValue([]);

      const res = mockRes();
      await getTeacherScopedStudents({ userAuth: user }, res);

      expect(Student.find.mock.calls[0][0]).toEqual({});
      expect(Assignment.find).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    }
  });

  test("unknown caller (no admin/teacher row) falls into the restricted branch", async () => {
    mockAssignmentLean.mockResolvedValue([]);

    const res = mockRes();
    await getTeacherScopedStudents({ userAuth: { id: "ghost-1" } }, res);

    expect(Assignment.find).toHaveBeenCalledWith({ teacher: "ghost-1" });
    expect(Student.find).not.toHaveBeenCalled();
  });
});

describe("teacher-scoped students — payload shape", () => {
  test("sectionRef wins over legacy section; missing class data stays null", async () => {
    mockStudentLean.mockResolvedValue([
      { _id: "s1", name: "Alice", rollNumber: "R1", classLevel: { _id: "c1", gradeLevel: "9", section: "Girls", sectionRef: { name: "Boys" } } },
      { _id: "s2", name: "Bob", rollNumber: "R2", classLevel: { _id: "c2", gradeLevel: "10", section: "Girls", sectionRef: null } },
      { _id: "s3", name: "Carol", rollNumber: "R3", classLevel: null },
    ]);

    const res = mockRes();
    await getTeacherScopedStudents({ userAuth: ADMIN }, res);

    expect(res.json.mock.calls[0][0].data.students).toEqual([
      { _id: "s1", name: "Alice", rollNumber: "R1", grade: "9", section: "Boys", classLevelId: "c1" },
      { _id: "s2", name: "Bob", rollNumber: "R2", grade: "10", section: "Girls", classLevelId: "c2" },
      { _id: "s3", name: "Carol", rollNumber: "R3", grade: null, section: null, classLevelId: null },
    ]);
  });
});
