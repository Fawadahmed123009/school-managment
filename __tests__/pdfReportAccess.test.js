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
} = require("../controllers/academic/pdfReport.controller");

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
