/**
 * Tests for the teacher subject-assignment authorization middleware.
 *
 * Verifies that:
 *   • A teacher assigned to (Subject A, Class 9) CAN access a test for Subject A / Class 9.
 *   • The same teacher CANNOT access a test for Subject B / Class 10.
 *   • The middleware passes through when no identifiable resource is found.
 *
 * The legacy Exam-based mark-entry strategies (req.body.exam / req.body.marks[])
 * were retired alongside the /marks and /marks/bulk routes, so their tests were
 * removed with them.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAssignmentFindOne = jest.fn();
const mockTestFindById = jest.fn();
const mockTeacherFindById = jest.fn();

jest.mock("../models/Academic/assignment.model", () => ({
  findOne: (...a) => mockAssignmentFindOne(...a),
}));
jest.mock("../models/Academic/test.model", () => ({
  findById: (...a) => mockTestFindById(...a),
}));
// isAssignedToTestView reads the Teacher doc to detect the manager bypass.
jest.mock("../models/Staff/teachers.model", () => ({
  findById: (...a) => {
    const q = {
      select: () => q,
      lean: () => Promise.resolve(mockTeacherFindById(...a)),
    };
    return q;
  },
}));

const isAssignedToSubject = require("../middlewares/isAssignedToSubject");
const { isAssignedToTestView } = require("../middlewares/isAssignedToSubject");

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

  // ── N+1 regression: one Assignment query regardless of classLevels length ──

  test("N+1: issues exactly ONE Assignment.findOne with classLevel $in for multi-class tests", async () => {
    const testDoc = {
      _id: "test-n1",
      subject: SUBJECT_A,
      classLevels: [CLASS_9, CLASS_10, "cls-11", "cls-12"],
    };
    mockTestFindById.mockResolvedValue(testDoc);
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });

    const req = mockReqWithTest("test-n1");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockAssignmentFindOne).toHaveBeenCalledTimes(1);
    const query = mockAssignmentFindOne.mock.calls[0][0];
    expect(query.teacher).toBe(TEACHER_ID);
    expect(query.subject).toBe(SUBJECT_A);
    expect(query.classLevel).toEqual({ $in: [CLASS_9, CLASS_10, "cls-11", "cls-12"] });
  });

  test("N+1: multi-class miss still costs exactly ONE Assignment.findOne (no per-class loop)", async () => {
    const testDoc = { _id: "test-n2", subject: SUBJECT_A, classLevels: [CLASS_9, CLASS_10] };
    mockTestFindById.mockResolvedValue(testDoc);
    mockAssignmentFindOne.mockResolvedValue(null);

    const req = mockReqWithTest("test-n2");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockAssignmentFindOne).toHaveBeenCalledTimes(1);
  });

  test("returns false (403) without querying when test has no classLevels", async () => {
    mockTestFindById.mockResolvedValue({ _id: "test-5", subject: SUBJECT_A, classLevels: [] });

    const req = mockReqWithTest("test-5");
    const res = mockRes();
    const next = jest.fn();

    await isAssignedToSubject(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockAssignmentFindOne).not.toHaveBeenCalled();
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

// ── View-route middleware (cookie-session auth, /tests/mark/:testId) ─────────

describe("isAssignedToTestView middleware (view routes)", () => {
  const SUBJECT_A = "sub-a";
  const CLASS_9 = "cls-9";
  const CLASS_10 = "cls-10";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function viewMockRes() {
    const res = {};
    res.locals = { schoolName: "Test School" };
    res.status = jest.fn().mockReturnValue(res);
    res.render = jest.fn().mockReturnValue(res);
    res.redirect = jest.fn();
    return res;
  }

  function viewReq(testId) {
    return { params: { testId }, user: { _id: "teacher-view-1", isSuspended: false } };
  }

  test("GRANTS access when teacher is assigned to one of the test's class levels", async () => {
    mockTeacherFindById.mockResolvedValue({ isAttendanceManager: false });
    mockTestFindById.mockResolvedValue({ _id: "t1", subject: SUBJECT_A, classLevels: [CLASS_9, CLASS_10] });
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });

    const req = viewReq("t1");
    const res = viewMockRes();
    const next = jest.fn();

    await isAssignedToTestView(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.render).not.toHaveBeenCalled();
    // Single round-trip via $in, even for a two-class test
    expect(mockAssignmentFindOne).toHaveBeenCalledTimes(1);
    expect(mockAssignmentFindOne.mock.calls[0][0].classLevel).toEqual({ $in: [CLASS_9, CLASS_10] });
  });

  test("DENIES (403) when teacher is assigned to none of the test's class levels", async () => {
    mockTeacherFindById.mockResolvedValue({ isAttendanceManager: false });
    mockTestFindById.mockResolvedValue({ _id: "t2", subject: SUBJECT_A, classLevels: [CLASS_9, CLASS_10] });
    mockAssignmentFindOne.mockResolvedValue(null);

    const req = viewReq("t2");
    const res = viewMockRes();
    const next = jest.fn();

    await isAssignedToTestView(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.render).toHaveBeenCalledWith("error", expect.objectContaining({
      message: expect.stringMatching(/not assigned/i),
    }));
    expect(mockAssignmentFindOne).toHaveBeenCalledTimes(1);
  });

  test("manager bypass skips the assignment query entirely", async () => {
    mockTeacherFindById.mockResolvedValue({ isAttendanceManager: true });

    const req = viewReq("t3");
    const res = viewMockRes();
    const next = jest.fn();

    await isAssignedToTestView(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockAssignmentFindOne).not.toHaveBeenCalled();
  });
});
