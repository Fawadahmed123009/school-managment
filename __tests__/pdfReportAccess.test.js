/**
 * Tests for audit Findings 1.1 and 2.2 — access control on PDF report generation.
 *
 * Finding 1.1: generateResultSheet must verify the requesting teacher is
 * assigned to the test's subject/class before generating.
 *
 * Finding 2.2: generateAnalytics must verify the teacher is assigned to the
 * requested subject and teaches the requested student.
 *
 * These tests mock the model layer and call the controller directly,
 * simulating req/res objects to confirm the rejection is loud (403) and clear.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockTestFindById = jest.fn();
const mockAssignmentFindOne = jest.fn();
const mockAssignmentFind = jest.fn();
const mockStudentFindById = jest.fn();
const mockTestResultFind = jest.fn();
const mockTestFind = jest.fn();
const mockTestSessionFindById = jest.fn();
const mockStudentFindByIdForService = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  findById: (...a) => mockTestFindById(...a),
  find: (...a) => mockTestFind(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  findOne: (...a) => mockAssignmentFindOne(...a),
  find: (...a) => {
    const result = mockAssignmentFind(...a);
    return { select: () => ({ lean: () => result }) };
  },
}));
jest.mock("../models/Students/students.model", () => ({
  findById: (...a) => {
    const result = mockStudentFindById(...a);
    return { select: () => ({ lean: () => result }) };
  },
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockTestResultFind(...a),
}));
jest.mock("../models/Academic/testSession.model", () => ({
  findById: (...a) => mockTestSessionFindById(...a),
}));

// The controller resolves admin/manager/teacher identity from the DB (the API
// token only carries { id }). Default to "not an admin, a plain non-manager
// teacher" so the restricted branch is exercised; admin/manager test cases
// short-circuit before these are consulted (they pass role/isManager on the
// fake req.userAuth, which the resolver honors).
jest.mock("../models/Staff/admin.model", () => ({
  findById: () => ({ select: () => ({ lean: async () => null }) }),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  findById: () => ({ select: () => ({ lean: async () => ({ isAttendanceManager: false }) }) }),
}));

// Mock pdfReportService to avoid actual PDF generation
jest.mock("../services/academic/pdfReport.service", () => ({
  generateResultSheetPDF: jest.fn().mockResolvedValue({ uuid: "test-uuid", singleStudent: null }),
  generateAnalyticsPDF: jest.fn().mockResolvedValue({ uuid: "test-uuid", singleStudent: null }),
  generateSessionReportPDF: jest.fn().mockResolvedValue({ uuid: "test-uuid", singleStudent: null }),
  getPdfPath: jest.fn(),
}));

// Mock responseStatus to capture calls
const mockResponseStatus = jest.fn((res, status, statusText, data) => {
  res.status(status).json({ status: statusText, message: data });
});
jest.mock("../handlers/responseStatus.handler", () => mockResponseStatus);

const {
  generateResultSheet,
  generateAnalytics,
  generateSessionReport,
} = require("../controllers/academic/pdfReport.controller");

// Access the mocked service so we can assert the teacher *scope* that the
// controller hands to gatherAnalytics (the real fix for the A-1 leak lives in
// that scope being non-null and correctly built for teachers).
const pdfReportService = require("../services/academic/pdfReport.service");

// ── Helpers ──────────────────────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(body, userOverrides = {}) {
  return {
    body,
    userAuth: {
      id: "teacher-1",
      role: "teacher",
      isManager: false,
      ...userOverrides,
    },
  };
}

// Simulate the REAL API Bearer token, which (see utils/tokenGenerator.js)
// carries ONLY { id } — no role, no isManager. Access control must still apply
// by deriving identity from the DB.
function mockReqBare(body, id) {
  return { body, userAuth: { id } };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SUBJECT_MATH = "507f1f77bcf86cd799439011";
const SUBJECT_SCIENCE = "507f1f77bcf86cd799439022";
const CLASS_9A = "507f1f77bcf86cd799439033";
const CLASS_9B = "507f1f77bcf86cd799439044";
const TEACHER_A = "teacher-a";
const TEACHER_B = "teacher-b";
const STUDENT_IN_9A = "student-9a";
const STUDENT_IN_9B = "student-9b";
const TEST_ID = "test-math-1";

// ── Tests: Finding 1.1 — Result Sheet Access Control ────────────────────────
describe("Finding 1.1: generateResultSheet — teacher assignment check", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("REJECTS teacher who is NOT assigned to the test's subject/class (403)", async () => {
    // Test belongs to Math subject, class 9A
    const testDoc = {
      _id: TEST_ID,
      subject: { _id: SUBJECT_MATH, name: "Math" },
      classLevels: [{ _id: CLASS_9A, name: "9A" }],
    };
    mockTestFindById.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockResolvedValue(testDoc),
      }),
    });
    // Teacher B is NOT assigned to Math for 9A
    mockAssignmentFindOne.mockResolvedValue(null);

    const req = mockReq({ testId: TEST_ID }, { id: TEACHER_B, role: "teacher", isManager: false });
    const res = mockRes();

    await generateResultSheet(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/not assigned/i);
  });

  test("ACCEPTS teacher who IS assigned to the test's subject/class (200)", async () => {
    const testDoc = {
      _id: TEST_ID,
      subject: { _id: SUBJECT_MATH, name: "Math" },
      classLevels: [{ _id: CLASS_9A, name: "9A" }],
    };
    mockTestFindById.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockResolvedValue(testDoc),
      }),
    });
    // Teacher A IS assigned to Math for 9A
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });

    const req = mockReq({ testId: TEST_ID }, { id: TEACHER_A, role: "teacher", isManager: false });
    const res = mockRes();

    await generateResultSheet(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
  });

  test("ACCEPTS admin without assignment check (200)", async () => {
    const testDoc = {
      _id: TEST_ID,
      subject: { _id: SUBJECT_MATH, name: "Math" },
      classLevels: [{ _id: CLASS_9A, name: "9A" }],
    };
    mockTestFindById.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockResolvedValue(testDoc),
      }),
    });

    const req = mockReq({ testId: TEST_ID }, { id: "admin-1", role: "admin", isManager: false });
    const res = mockRes();

    await generateResultSheet(req, res);

    // Admin should NOT get 403 — assignment check is bypassed
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("REJECTS when test is not found (404)", async () => {
    mockTestFindById.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
      }),
    });

    const req = mockReq({ testId: "nonexistent" });
    const res = mockRes();

    await generateResultSheet(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ── Tests: Finding 2.2 — Analytics PDF Access Control ────────────────────────
describe("Finding 2.2: generateAnalytics — teacher assignment check", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("REJECTS teacher requesting a subject they are NOT assigned to (403)", async () => {
    // Teacher is assigned to Math only
    mockAssignmentFind.mockResolvedValue([
      { subject: SUBJECT_MATH, classLevel: CLASS_9A },
    ]);

    const req = mockReq(
      { subjectId: SUBJECT_SCIENCE },
      { id: TEACHER_A, role: "teacher", isManager: false }
    );
    const res = mockRes();

    await generateAnalytics(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/not assigned/i);
  });

  test("REJECTS teacher requesting a student in a class they don't teach (403)", async () => {
    // Teacher is assigned to Math for 9A only
    mockAssignmentFind.mockResolvedValue([
      { subject: SUBJECT_MATH, classLevel: CLASS_9A },
    ]);
    // Student is in class 9B (teacher doesn't teach them)
    mockStudentFindById.mockResolvedValue({ classLevel: CLASS_9B });

    const req = mockReq(
      { studentId: STUDENT_IN_9B, subjectId: SUBJECT_MATH },
      { id: TEACHER_A, role: "teacher", isManager: false }
    );
    const res = mockRes();

    await generateAnalytics(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/not assigned/i);
  });

  test("ACCEPTS teacher requesting their own subject + student in their class (200)", async () => {
    mockAssignmentFind.mockResolvedValue([
      { subject: SUBJECT_MATH, classLevel: CLASS_9A },
    ]);
    mockStudentFindById.mockResolvedValue({ classLevel: CLASS_9A });

    const req = mockReq(
      { studentId: STUDENT_IN_9A, subjectId: SUBJECT_MATH },
      { id: TEACHER_A, role: "teacher", isManager: false }
    );
    const res = mockRes();

    await generateAnalytics(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
  });

  test("ACCEPTS admin without assignment check (200)", async () => {
    const req = mockReq(
      { studentId: STUDENT_IN_9B, subjectId: SUBJECT_SCIENCE },
      { id: "admin-1", role: "admin", isManager: false }
    );
    const res = mockRes();

    await generateAnalytics(req, res);

    // Admin should bypass all assignment checks
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("ACCEPTS manager without assignment check (200)", async () => {
    const req = mockReq(
      { studentId: STUDENT_IN_9B, subjectId: SUBJECT_SCIENCE },
      { id: "manager-1", role: "teacher", isManager: true }
    );
    const res = mockRes();

    await generateAnalytics(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

// ── Tests: Finding A-1 (round 2) — analytics must be scope-constrained, ──────
// not merely "checked for presence". Omitting subjectId or studentId must NOT
// fall through to an unscoped, school-wide query.
describe("Finding A-1: generateAnalytics — teacher query is intersection-scoped", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("Omitting subjectId still constrains the query to the teacher's subjects/classes", async () => {
    // Teacher assigned to Math for 9A only.
    mockAssignmentFind.mockResolvedValue([{ subject: SUBJECT_MATH, classLevel: CLASS_9A }]);

    const req = mockReq({}, { id: TEACHER_A, role: "teacher", isManager: false });
    const res = mockRes();

    await generateAnalytics(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // The service MUST receive a non-null scope so gatherAnalytics cannot
    // return every result school-wide when subjectId is omitted.
    const call = pdfReportService.generateAnalyticsPDF.mock.calls[0];
    const scope = call[2];
    expect(scope).not.toBeNull();
    expect(scope.teacherSubjectIds).toContain(SUBJECT_MATH);
    expect(scope.subjectClassMap[SUBJECT_MATH].has(CLASS_9A)).toBe(true);
    expect(scope.subjectClassMap[SUBJECT_MATH].has(CLASS_9B)).toBe(false);
  });

  test("Valid subjectId but omitted studentId still constrains classes via the scope", async () => {
    // Teacher assigned to Math for 9A only — requesting Math without a student
    // must NOT return all classes that took Math.
    mockAssignmentFind.mockResolvedValue([{ subject: SUBJECT_MATH, classLevel: CLASS_9A }]);

    const req = mockReq({ subjectId: SUBJECT_MATH }, { id: TEACHER_A, role: "teacher", isManager: false });
    const res = mockRes();

    await generateAnalytics(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const scope = pdfReportService.generateAnalyticsPDF.mock.calls[0][2];
    expect(scope).not.toBeNull();
    // Only 9A is granted for Math — 9B students are excluded by the scope.
    expect([...scope.subjectClassMap[SUBJECT_MATH]]).toEqual([CLASS_9A]);
  });

  test("Admin analytics are NOT scoped (scope is null → full access preserved)", async () => {
    const req = mockReq({}, { id: "admin-1", role: "admin", isManager: false });
    const res = mockRes();

    await generateAnalytics(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(pdfReportService.generateAnalyticsPDF.mock.calls[0][2]).toBeNull();
  });

  test("ROOT CAUSE: an id-only API token (no role) is still teacher-scoped", async () => {
    // The real Bearer token has no role/isManager; identity comes from the DB
    // (mocked as a plain non-manager teacher). A request for an unassigned
    // subject must still be rejected with 403, not silently allowed through.
    mockAssignmentFind.mockResolvedValue([{ subject: SUBJECT_MATH, classLevel: CLASS_9A }]);

    const req = mockReqBare({ subjectId: SUBJECT_SCIENCE }, TEACHER_A);
    const res = mockRes();

    await generateAnalytics(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].message).toMatch(/not assigned/i);
  });
});

// ── Tests: Finding B-1 — session-report PDF had NO teacher access control. ───
describe("Finding B-1: generateSessionReport — teacher blocked, admin/manager allowed", () => {
  const SESSION_ID = "session-1";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("REJECTS any teacher (non-manager) attempting a session report (403)", async () => {
    const req = mockReq(
      { sessionId: SESSION_ID, studentId: STUDENT_IN_9A },
      { id: TEACHER_A, role: "teacher", isManager: false }
    );
    const res = mockRes();

    await generateSessionReport(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/admin/i);
    // It must never reach the PDF generator.
    expect(pdfReportService.generateSessionReportPDF).not.toHaveBeenCalled();
  });

  test("ACCEPTS admin (200)", async () => {
    const req = mockReq(
      { sessionId: SESSION_ID, studentId: STUDENT_IN_9A },
      { id: "admin-1", role: "admin", isManager: false }
    );
    const res = mockRes();

    await generateSessionReport(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("ACCEPTS manager (200)", async () => {
    const req = mockReq(
      { sessionId: SESSION_ID, studentId: STUDENT_IN_9A },
      { id: "manager-1", role: "teacher", isManager: true }
    );
    const res = mockRes();

    await generateSessionReport(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  test("REJECTS when required params are missing (400)", async () => {
    const req = mockReq({ sessionId: SESSION_ID }, { id: "admin-1", role: "admin", isManager: false });
    const res = mockRes();

    await generateSessionReport(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("ROOT CAUSE: an id-only API token (no role) is rejected (403)", async () => {
    // Real teacher Bearer token = { id } only; DB resolves a plain teacher.
    const req = mockReqBare({ sessionId: SESSION_ID, studentId: STUDENT_IN_9A }, TEACHER_A);
    const res = mockRes();

    await generateSessionReport(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(pdfReportService.generateSessionReportPDF).not.toHaveBeenCalled();
  });
});
