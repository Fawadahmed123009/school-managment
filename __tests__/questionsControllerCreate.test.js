/**
 * Regression test for the teacher "create question" controller bug.
 *
 * Bug (fixed in 14b277b): createQuestionsController destructured
 * `createExamService` from questions.service.js, but that module only exports
 * `createQuestionsService` (createExamService lives in exams.service.js). The
 * named import was therefore `undefined`, so the controller threw
 * "createExamService is not a function" and always returned HTTP 400 "failed"
 * — teacher question creation never worked.
 *
 * The service module is mocked with its REAL export names. On the pre-fix code
 * the controller would call a non-existent export, hit the try/catch, and emit
 * a 400 "failed" envelope. On the fixed code it must delegate to
 * createQuestionsService with the exact (data, examId, teacherId, res) args and
 * surface the service's success response untouched.
 */

const responseStatus = require("../handlers/responseStatus.handler");

const mockCreateQuestionsService = jest.fn();

jest.mock("../services/academic/questions.service", () => ({
  createQuestionsService: (...a) => mockCreateQuestionsService(...a),
  getAllQuestionsService: jest.fn(),
  getQuestionsByIdService: jest.fn(),
  updateQuestionsService: jest.fn(),
}));

const {
  createQuestionsController,
} = require("../controllers/academic/questions.controller");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const envelope = (res) => res.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  // Mirror the real service: it writes the response and returns nothing.
  mockCreateQuestionsService.mockImplementation(async (data, examId, teacherId, res) =>
    responseStatus(res, 201, "success", { _id: "q1", question: data.question })
  );
});

const buildReq = () => ({
  body: {
    question: "2 + 2?",
    optionA: "3",
    optionB: "4",
    optionC: "5",
    optionD: "6",
    correctAnswer: "4",
  },
  params: { examId: "exam-abc" },
  userAuth: { id: "teacher-xyz" },
});

describe("createQuestionsController — delegates to createQuestionsService", () => {
  it("calls createQuestionsService once with (body, examId, teacherId, res)", async () => {
    const req = buildReq();
    const res = mockRes();

    await createQuestionsController(req, res);

    expect(mockCreateQuestionsService).toHaveBeenCalledTimes(1);
    expect(mockCreateQuestionsService).toHaveBeenCalledWith(
      req.body,
      "exam-abc",
      "teacher-xyz",
      res
    );
  });

  it("surfaces the service 201 success envelope (not a 400 failure)", async () => {
    const req = buildReq();
    const res = mockRes();

    await createQuestionsController(req, res);

    // Pre-fix this asserted 400 "failed" because the invoked symbol was undefined.
    expect(res.status).toHaveBeenCalledWith(201);
    expect(envelope(res)).toMatchObject({ status: "success" });
    expect(envelope(res).status).not.toBe("failed");
  });

  it("still maps a thrown service error to a 400 failed envelope", async () => {
    mockCreateQuestionsService.mockRejectedValueOnce(
      new Error("Exam not found")
    );
    const req = buildReq();
    const res = mockRes();

    await createQuestionsController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(envelope(res)).toMatchObject({ status: "failed", message: "Exam not found" });
  });
});
