/**
 * Audit-fix tests covering three security / data-integrity fixes:
 *
 * 1. PDF Report Authorization — only admins and teachers may generate/fetch PDFs.
 *    Students and parents must be rejected with 403.
 *
 * 2. Question Bank Assignment Scoping — teachers may only view/edit questions
 *    belonging to exams for subjects they are assigned to teach.
 *
 * 3. Student Deletion Cascade — deleting a student must clean up Attendance,
 *    TestResult, and Parent.children references, and must be blocked when
 *    paid fee records exist.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 1 — PDF Report Authorization (isAdminOrTeacher middleware)
// ═══════════════════════════════════════════════════════════════════════════════

const mockPdfAdminFindById = jest.fn();
const mockPdfTeacherFindById = jest.fn();

jest.mock("../models/Staff/admin.model", () => ({
  findById: (...a) => mockPdfAdminFindById(...a),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  findById: (...a) => mockPdfTeacherFindById(...a),
}));

const isAdminOrTeacher = require("../middlewares/isAdminOrTeacher");

function pdfMockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("Fix 1 — PDF Report Authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("admin is ALLOWED to generate PDFs", async () => {
    mockPdfAdminFindById.mockResolvedValue({ _id: "admin-1", role: "admin" });
    mockPdfTeacherFindById.mockResolvedValue(null);

    const req = { userAuth: { id: "admin-1" } };
    const res = pdfMockRes();
    const next = jest.fn();

    await isAdminOrTeacher(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("teacher is ALLOWED to generate PDFs", async () => {
    mockPdfAdminFindById.mockResolvedValue(null);
    mockPdfTeacherFindById.mockResolvedValue({ _id: "teacher-1", role: "teacher" });

    const req = { userAuth: { id: "teacher-1" } };
    const res = pdfMockRes();
    const next = jest.fn();

    await isAdminOrTeacher(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("student is REJECTED (403) from PDF generation", async () => {
    // Student model is not Admin or Teacher, so both lookups return null
    mockPdfAdminFindById.mockResolvedValue(null);
    mockPdfTeacherFindById.mockResolvedValue(null);

    const req = { userAuth: { id: "student-1" } };
    const res = pdfMockRes();
    const next = jest.fn();

    await isAdminOrTeacher(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/admins and teachers only/i);
  });

  test("parent is REJECTED (403) from PDF generation", async () => {
    mockPdfAdminFindById.mockResolvedValue(null);
    mockPdfTeacherFindById.mockResolvedValue(null);

    const req = { userAuth: { id: "parent-1" } };
    const res = pdfMockRes();
    const next = jest.fn();

    await isAdminOrTeacher(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/admins and teachers only/i);
  });

  test("unauthenticated request (no userAuth) is REJECTED (403)", async () => {
    mockPdfAdminFindById.mockResolvedValue(null);
    mockPdfTeacherFindById.mockResolvedValue(null);

    const req = {};
    const res = pdfMockRes();
    const next = jest.fn();

    await isAdminOrTeacher(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 2 — Question Bank Assignment Scoping (isAssignedToQuestionExam middleware)
// ═══════════════════════════════════════════════════════════════════════════════

const mockQExamFindById = jest.fn();
const mockQExamFindOne = jest.fn();
const mockQAssignmentFindOne = jest.fn();

jest.mock("../models/Academic/exams.model", () => ({
  findById: (...a) => mockQExamFindById(...a),
  findOne: (...a) => mockQExamFindOne(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  findOne: (...a) => mockQAssignmentFindOne(...a),
  find: jest.fn(),
}));

const isAssignedToQuestionExam = require("../middlewares/isAssignedToQuestionExam");

function qMockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("Fix 2 — Question Bank Assignment Scoping", () => {
  const TEACHER_ID = "teacher-q1";
  const SUBJECT_MATH = "sub-math";
  const SUBJECT_BIO = "sub-bio";
  const CLASS_9 = "cls-9";
  const CLASS_10 = "cls-10";
  const EXAM_MATH = "exam-math";
  const EXAM_BIO = "exam-bio";
  const QUESTION_MATH = "q-math-1";
  const QUESTION_BIO = "q-bio-1";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── POST /questions/:examId/create ──────────────────────────────────────────

  describe("POST /questions/:examId/create (examId in params)", () => {
    test("ASSIGNED teacher can create questions for their subject's exam", async () => {
      mockQExamFindById.mockResolvedValue({
        _id: EXAM_MATH,
        subject: SUBJECT_MATH,
        classLevel: CLASS_9,
      });
      mockQAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });

      const req = { params: { examId: EXAM_MATH }, body: {}, userAuth: { id: TEACHER_ID } };
      const res = qMockRes();
      const next = jest.fn();

      await isAssignedToQuestionExam(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    test("UNASSIGNED teacher is REJECTED (403) when creating questions for another subject's exam", async () => {
      mockQExamFindById.mockResolvedValue({
        _id: EXAM_BIO,
        subject: SUBJECT_BIO,
        classLevel: CLASS_10,
      });
      mockQAssignmentFindOne.mockResolvedValue(null);

      const req = { params: { examId: EXAM_BIO }, body: {}, userAuth: { id: TEACHER_ID } };
      const res = qMockRes();
      const next = jest.fn();

      await isAssignedToQuestionExam(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      const body = res.json.mock.calls[0][0];
      expect(body.message).toMatch(/not assigned/i);
    });
  });

  // ── GET /question/:questionId ───────────────────────────────────────────────

  describe("GET /question/:questionId (questionId in params)", () => {
    test("ASSIGNED teacher can view a question from their subject's exam", async () => {
      mockQExamFindById.mockResolvedValue(null); // no examId param
      mockQExamFindOne.mockResolvedValue({
        _id: EXAM_MATH,
        subject: SUBJECT_MATH,
        classLevel: CLASS_9,
      });
      mockQAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });

      const req = { params: { questionId: QUESTION_MATH }, body: {}, userAuth: { id: TEACHER_ID } };
      const res = qMockRes();
      const next = jest.fn();

      await isAssignedToQuestionExam(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    test("UNASSIGNED teacher is REJECTED (403) when viewing another subject's question", async () => {
      mockQExamFindById.mockResolvedValue(null);
      mockQExamFindOne.mockResolvedValue({
        _id: EXAM_BIO,
        subject: SUBJECT_BIO,
        classLevel: CLASS_10,
      });
      mockQAssignmentFindOne.mockResolvedValue(null);

      const req = { params: { questionId: QUESTION_BIO }, body: {}, userAuth: { id: TEACHER_ID } };
      const res = qMockRes();
      const next = jest.fn();

      await isAssignedToQuestionExam(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test("returns 404 when question is not found in any exam", async () => {
      mockQExamFindById.mockResolvedValue(null);
      mockQExamFindOne.mockResolvedValue(null);

      const req = { params: { questionId: "nonexistent" }, body: {}, userAuth: { id: TEACHER_ID } };
      const res = qMockRes();
      const next = jest.fn();

      await isAssignedToQuestionExam(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  // ── PATCH /question/:questionId ─────────────────────────────────────────────

  describe("PATCH /question/:questionId (questionId in params)", () => {
    test("ASSIGNED teacher can update a question from their subject's exam", async () => {
      mockQExamFindById.mockResolvedValue(null);
      mockQExamFindOne.mockResolvedValue({
        _id: EXAM_MATH,
        subject: SUBJECT_MATH,
        classLevel: CLASS_9,
      });
      mockQAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });

      const req = { params: { questionId: QUESTION_MATH }, body: {}, userAuth: { id: TEACHER_ID } };
      const res = qMockRes();
      const next = jest.fn();

      await isAssignedToQuestionExam(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    test("UNASSIGNED teacher is REJECTED (403) when updating another subject's question", async () => {
      mockQExamFindById.mockResolvedValue(null);
      mockQExamFindOne.mockResolvedValue({
        _id: EXAM_BIO,
        subject: SUBJECT_BIO,
        classLevel: CLASS_10,
      });
      mockQAssignmentFindOne.mockResolvedValue(null);

      const req = { params: { questionId: QUESTION_BIO }, body: {}, userAuth: { id: TEACHER_ID } };
      const res = qMockRes();
      const next = jest.fn();

      await isAssignedToQuestionExam(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  // ── GET /question (list all — pass-through, scoped by service) ─────────────

  describe("GET /question (list all — no exam/questionId in params)", () => {
    test("passes through to controller/service (scoping happens in service layer)", async () => {
      const req = { params: {}, body: {}, userAuth: { id: TEACHER_ID } };
      const res = qMockRes();
      const next = jest.fn();

      await isAssignedToQuestionExam(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 3 — Student Deletion Cascade Cleanup
// ═══════════════════════════════════════════════════════════════════════════════

const mockStudentFindById = jest.fn();
const mockStudentFindByIdAndDelete = jest.fn();
const mockFeesFindOne = jest.fn();
const mockAttendanceDeleteMany = jest.fn();
const mockTestResultDeleteMany = jest.fn();
const mockParentUpdateMany = jest.fn();

jest.mock("../models/Students/students.model", () => ({
  findById: (...a) => mockStudentFindById(...a),
  findByIdAndDelete: (...a) => mockStudentFindByIdAndDelete(...a),
}));
jest.mock("../models/Fees/fees.model", () => ({
  findOne: (...a) => mockFeesFindOne(...a),
}));
jest.mock("../models/Academic/attendance.model", () => ({
  deleteMany: (...a) => mockAttendanceDeleteMany(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  deleteMany: (...a) => mockTestResultDeleteMany(...a),
}));
jest.mock("../models/Parents/parents.model", () => ({
  updateMany: (...a) => mockParentUpdateMany(...a),
}));

const { adminDeleteStudentService } = require("../services/students/students.service");

function delMockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("Fix 3 — Student Deletion Cascade Cleanup", () => {
  const STUDENT_ID = "student-del-1";

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: student exists, no paid fees, all deletes succeed
    mockStudentFindById.mockResolvedValue({ _id: STUDENT_ID, name: "Test Student" });
    mockFeesFindOne.mockResolvedValue(null);
    mockStudentFindByIdAndDelete.mockResolvedValue({ _id: STUDENT_ID });
    mockAttendanceDeleteMany.mockResolvedValue({ deletedCount: 5 });
    mockTestResultDeleteMany.mockResolvedValue({ deletedCount: 3 });
    mockParentUpdateMany.mockResolvedValue({ modifiedCount: 1 });
  });

  // ── Blocked deletion ────────────────────────────────────────────────────────

  test("BLOCKS deletion (403) when student has Paid fee records", async () => {
    mockFeesFindOne.mockResolvedValue({ _id: "fee-paid-1", status: "paid" });

    const res = delMockRes();
    await adminDeleteStudentService(STUDENT_ID, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/paid fee records/i);

    // Student must NOT be deleted
    expect(mockStudentFindByIdAndDelete).not.toHaveBeenCalled();
    // Cascade cleanups must NOT run
    expect(mockAttendanceDeleteMany).not.toHaveBeenCalled();
    expect(mockTestResultDeleteMany).not.toHaveBeenCalled();
    expect(mockParentUpdateMany).not.toHaveBeenCalled();
  });

  // ── Successful deletion with cascade ────────────────────────────────────────

  test("deletes student and cascades: Attendance, TestResult, Parent.children cleanup", async () => {
    const res = delMockRes();
    await adminDeleteStudentService(STUDENT_ID, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");

    // Verify cascade deletions were called with correct student ID
    expect(mockAttendanceDeleteMany).toHaveBeenCalledWith({ student: STUDENT_ID });
    expect(mockTestResultDeleteMany).toHaveBeenCalledWith({ student: STUDENT_ID });
    expect(mockParentUpdateMany).toHaveBeenCalledWith(
      { children: STUDENT_ID },
      { $pull: { children: STUDENT_ID } }
    );

    // Verify student was actually deleted
    expect(mockStudentFindByIdAndDelete).toHaveBeenCalledWith(STUDENT_ID);
  });

  test("pending/partial Fee records do NOT block deletion", async () => {
    // Fees.findOne with status: "paid" returns null (only pending/partial exist)
    mockFeesFindOne.mockResolvedValue(null);

    const res = delMockRes();
    await adminDeleteStudentService(STUDENT_ID, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockStudentFindByIdAndDelete).toHaveBeenCalledWith(STUDENT_ID);
  });

  test("student not found returns 404", async () => {
    mockStudentFindById.mockResolvedValue(null);

    const res = delMockRes();
    await adminDeleteStudentService("nonexistent-id", res);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0][0];
    expect(body).toBeDefined();
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/not found/i);

    // No cascade operations should run
    expect(mockAttendanceDeleteMany).not.toHaveBeenCalled();
    expect(mockTestResultDeleteMany).not.toHaveBeenCalled();
    expect(mockParentUpdateMany).not.toHaveBeenCalled();
  });

  test("cascade runs even when no Attendance/TestResult/Parent records exist (zero counts)", async () => {
    mockAttendanceDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockTestResultDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockParentUpdateMany.mockResolvedValue({ modifiedCount: 0 });

    const res = delMockRes();
    await adminDeleteStudentService(STUDENT_ID, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // All cascade operations were still called
    expect(mockAttendanceDeleteMany).toHaveBeenCalledWith({ student: STUDENT_ID });
    expect(mockTestResultDeleteMany).toHaveBeenCalledWith({ student: STUDENT_ID });
    expect(mockParentUpdateMany).toHaveBeenCalledWith(
      { children: STUDENT_ID },
      { $pull: { children: STUDENT_ID } }
    );
    expect(mockStudentFindByIdAndDelete).toHaveBeenCalledWith(STUDENT_ID);
  });
});
