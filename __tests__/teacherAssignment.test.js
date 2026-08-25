/**
 * Tests for the teacher subject-assignment authorization middleware.
 *
 * Verifies that:
 *   • A teacher assigned to (Subject A, Class 9) CAN access a test for Subject A / Class 9.
 *   • The same teacher CANNOT access a test for Subject B / Class 10.
 *   • The middleware correctly handles the legacy Exam-based bulk marks route.
 *   • The middleware passes through when no identifiable resource is found.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAssignmentFindOne = jest.fn();
const mockTestFindById = jest.fn();
const mockExamFindById = jest.fn();

jest.mock("../models/Academic/assignment.model", () => ({
  findOne: mockAssignmentFindOne,
}));
jest.mock("../models/Academic/test.model", () => ({
  findById: mockTestFindById,
}));
jest.mock("../models/Academic/exams.model", () => ({
  findById: mockExamFindById,
}));

const isAssignedToSubject = require("../middlewares/isAssignedToSubject");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function mockReqWithTest(testId) {
  return {
    params: { testId },
    body: {},
    userAuth: { id: "teacher-abc-123" },
  };
}

function mockReqWithExam(examId) {
  return {
    params: {},
    body: { exam: examId },
    userAuth: { id: "teacher-abc-123" },
  };
}

function mockReqWithBulkMarks(examIds) {
  return {
    params: {},
    body: { marks: examIds.map((eid) => ({ exam: eid, student: "s1", score: 80 })) },
    userAuth: { id: "teacher-abc-123" },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("isAssignedToSubject middleware (Test-based routes)", () => {
  const TEACHER_ID = "teacher-abc-123";
  const SUBJECT_A = "sub-a";
  const SUBJECT_B = "sub-b";
  const CLASS_9 = "cls-9";
  const CLASS_10 = "cls-10";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("ALLOWS teacher assigned to Subject A / Class 9 to access a test for Subject A / Class 9", async () => {
    const testDoc = { _id: "test-1", subject: SUBJECT_A, classLevels: [CLASS_9] };
    mockTestFindById.mockResolvedValue(testDoc);
    // Teacher IS assigned to Subject A + Class 9
    mockAssignmentFindOne.mockResolvedValueOnce({ _id: "assign-1" });

    const req = mockReqWithTest("test-1");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("REJECTS teacher assigned to Subject A / Class 9 when accessing Subject B / Class 10", async () => {
    const testDoc = { _id: "test-2", subject: SUBJECT_B, classLevels: [CLASS_10] };
    mockTestFindById.mockResolvedValue(testDoc);
    // Teacher is NOT assigned to Subject B + Class 10
    mockAssignmentFindOne.mockResolvedValueOnce(null);

    const req = mockReqWithTest("test-2");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/not assigned/i);
  });

  test("ALLOWS when test has multiple classLevels and teacher covers at least one", async () => {
    const testDoc = { _id: "test-3", subject: SUBJECT_A, classLevels: [CLASS_9, CLASS_10] };
    mockTestFindById.mockResolvedValue(testDoc);
    // Teacher assigned to Subject A + Class 9 (first class checked)
    mockAssignmentFindOne.mockResolvedValueOnce({ _id: "assign-1" });

    const req = mockReqWithTest("test-3");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test("REJECTS when test has multiple classLevels but teacher covers none", async () => {
    const testDoc = { _id: "test-4", subject: SUBJECT_A, classLevels: [CLASS_9, CLASS_10] };
    mockTestFindById.mockResolvedValue(testDoc);
    // Teacher not assigned to any of the test's classes for this subject
    mockAssignmentFindOne.mockResolvedValue(null);

    const req = mockReqWithTest("test-4");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("returns 404 when testId does not exist", async () => {
    mockTestFindById.mockResolvedValue(null);

    const req = mockReqWithTest("nonexistent");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("returns 401 when no userAuth (not authenticated)", async () => {
    const req = { params: { testId: "test-1" }, body: {}, userAuth: null };
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("isAssignedToSubject middleware (Legacy Exam-based single mark route)", () => {
  const TEACHER_ID = "teacher-abc-123";
  const SUBJECT_A = "sub-a";
  const CLASS_9 = "cls-9";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("ALLOWS teacher when assigned to the exam's subject/class", async () => {
    const examDoc = { _id: "exam-1", subject: SUBJECT_A, classLevel: CLASS_9, name: "Math Quiz" };
    mockExamFindById.mockResolvedValue(examDoc);
    mockAssignmentFindOne.mockResolvedValueOnce({ _id: "assign-1" });

    const req = mockReqWithExam("exam-1");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("REJECTS teacher when NOT assigned to the exam's subject/class", async () => {
    const examDoc = { _id: "exam-2", subject: "sub-b", classLevel: "cls-10", name: "Bio Quiz" };
    mockExamFindById.mockResolvedValue(examDoc);
    mockAssignmentFindOne.mockResolvedValueOnce(null);

    const req = mockReqWithExam("exam-2");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("isAssignedToSubject middleware (Legacy bulk marks route)", () => {
  const TEACHER_ID = "teacher-abc-123";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("REJECTS if ANY exam in the bulk payload belongs to an unassigned subject/class", async () => {
    // Two exams: one assigned, one not
    mockExamFindById
      .mockResolvedValueOnce({ _id: "exam-ok", subject: "sub-a", classLevel: "cls-9", name: "Math" })
      .mockResolvedValueOnce({ _id: "exam-bad", subject: "sub-b", classLevel: "cls-10", name: "Bio" });

    // Teacher IS assigned to first exam
    mockAssignmentFindOne.mockResolvedValueOnce({ _id: "assign-1" });
    // Teacher is NOT assigned to second exam
    mockAssignmentFindOne.mockResolvedValueOnce(null);

    const req = mockReqWithBulkMarks(["exam-ok", "exam-bad"]);
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("ALLOWS if ALL exams in the bulk payload match teacher's assignments", async () => {
    mockExamFindById
      .mockResolvedValueOnce({ _id: "exam-1", subject: "sub-a", classLevel: "cls-9", name: "Math Q1" })
      .mockResolvedValueOnce({ _id: "exam-2", subject: "sub-a", classLevel: "cls-9", name: "Math Q2" });

    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });

    const req = mockReqWithBulkMarks(["exam-1", "exam-2"]);
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("isAssignedToSubject middleware (pass-through)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("passes through when no testId, exam, or marks[] in request", async () => {
    const req = { params: {}, body: {}, userAuth: { id: "teacher-abc-123" } };
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
