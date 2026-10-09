/**
 * Tests for the session-report scoped-student endpoint (Feature 1).
 *
 * GET /pdf-reports/session-students must list ONLY the students who are in
 * scope for the chosen session — i.e. whose classLevel is covered by at least
 * one test in that session (derived from Test.classLevels) — restricted to the
 * currently-enrolled roster, and gated to admin/manager just like the report it
 * feeds.
 */

const mockTestDistinct = jest.fn();
const mockStudentFind = jest.fn();
const mockClassLevelFind = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  findById: jest.fn(),
  find: jest.fn(),
  distinct: (...a) => mockTestDistinct(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock("../models/Students/students.model", () => ({
  // Controller chains find().select().populate(classLevel).populate(parent).sort().lean().
  find: () => ({ select: () => ({ populate: () => ({ populate: () => ({ sort: () => ({ lean: () => mockStudentFind() }) }) }) }) }),
  findById: jest.fn(),
}));
jest.mock("../models/Academic/class.model", () => ({
  // Controller chains find().select().populate(sectionRef).sort().lean().
  find: () => ({ select: () => ({ populate: () => ({ sort: () => ({ lean: () => mockClassLevelFind() }) }) }) }),
}));
jest.mock("../models/Academic/testSession.model", () => ({ findById: jest.fn() }));

// Identity resolves from the DB: default "plain non-manager teacher" so a bare
// token exercises the restricted branch.
jest.mock("../models/Staff/admin.model", () => ({
  findById: () => ({ select: () => ({ lean: async () => null }) }),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  findById: () => ({ select: () => ({ lean: async () => ({ isAttendanceManager: false }) }) }),
}));

jest.mock("../services/academic/pdfReport.service", () => ({ getPdfPath: jest.fn() }));

jest.mock("../handlers/responseStatus.handler", () =>
  jest.fn((res, status, statusText, data) => {
    res.status(status).json(statusText === "success" ? { status: statusText, data } : { status: statusText, message: data });
  })
);

const { getSessionScopedStudents } = require("../controllers/academic/pdfReport.controller");

const SESSION_ID = "507f1f77bcf86cd799439055";
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

describe("session-scoped students — access control", () => {
  beforeEach(() => jest.clearAllMocks());

  test("rejects a plain teacher (403)", async () => {
    const res = mockRes();
    await getSessionScopedStudents({ query: { sessionId: SESSION_ID }, userAuth: { id: "teacher-1" } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockTestDistinct).not.toHaveBeenCalled();
  });

  test("accepts admin and manager", async () => {
    for (const user of [ADMIN, MANAGER]) {
      jest.clearAllMocks();
      mockTestDistinct.mockResolvedValue([]);
      const res = mockRes();
      await getSessionScopedStudents({ query: { sessionId: SESSION_ID }, userAuth: user }, res);
      expect(res.status).toHaveBeenCalledWith(200);
    }
  });
});

describe("session-scoped students — scoping and guards", () => {
  beforeEach(() => jest.clearAllMocks());

  test("invalid sessionId → 400 before any query", async () => {
    const res = mockRes();
    await getSessionScopedStudents({ query: { sessionId: "not-an-id" }, userAuth: ADMIN }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTestDistinct).not.toHaveBeenCalled();
  });

  test("derives the class set from the session's tests and queries only that set", async () => {
    mockTestDistinct.mockResolvedValue([CLASS_9A, CLASS_10B]);
    mockStudentFind.mockResolvedValue([
      { _id: "s1", name: "Alice", rollNumber: "R1" },
      { _id: "s2", name: "Bob", rollNumber: "R2" },
    ]);
    mockClassLevelFind.mockResolvedValue([
      { _id: CLASS_9A, gradeLevel: "9", group: null, section: null, sectionRef: { name: "Boys" }, name: "Class 9" },
      { _id: CLASS_10B, gradeLevel: "10", group: "Pre-Engineering", section: "Girls", sectionRef: null, name: "Class 10" },
    ]);

    const Student = require("../models/Students/students.model");
    const findSpy = jest.spyOn(Student, "find");

    const res = mockRes();
    await getSessionScopedStudents({ query: { sessionId: SESSION_ID }, userAuth: ADMIN }, res);

    // classLevels distinct is scoped to the picked session.
    expect(mockTestDistinct).toHaveBeenCalledWith("classLevels", { session: SESSION_ID });

    // Roster query limited to the covered classes AND currently enrolled.
    const filter = findSpy.mock.calls[0][0];
    expect(filter.classLevel.$in).toEqual([CLASS_9A, CLASS_10B]);
    expect(filter.status).toBe("active");
    expect(filter.isWithdrawn).toBe(false);
    expect(filter.isGraduated).toBe(false);
    findSpy.mockRestore();

    const payload = res.json.mock.calls[0][0].data;
    expect(payload.students.map((s) => s._id)).toEqual(["s1", "s2"]);

    // Classes are scoped to the session and shaped (sectionRef preferred over
    // the legacy `section` field) for the whole-grade / sections pickers.
    expect(payload.classes).toEqual([
      { _id: CLASS_9A, gradeLevel: "9", section: "Boys", name: "Class 9", group: null },
      { _id: CLASS_10B, gradeLevel: "10", section: "Girls", name: "Class 10", group: "Pre-Engineering" },
    ]);
  });

  test("session with no covered classes returns an empty list (no roster query)", async () => {
    mockTestDistinct.mockResolvedValue([]);
    const res = mockRes();
    await getSessionScopedStudents({ query: { sessionId: SESSION_ID }, userAuth: ADMIN }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.students).toEqual([]);
  });
});
