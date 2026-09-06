/**
 * Tests that deleteSubjectService and deleteProgramService work correctly when
 * called through captureServiceResponse() — the same pattern used by the view
 * routes after the fix.
 *
 * Previously the two delete routes called their services WITHOUT a response
 * object, causing silent crashes (the service tried to call res.status().json()
 * on undefined). These tests confirm the services behave properly when given a
 * captureServiceResponse proxy, and that the captured result accurately
 * reflects success/failure.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockSubjectFindById = jest.fn();
const mockSubjectFindByIdAndDelete = jest.fn();
const mockSubjectFindOne = jest.fn();
const mockSubjectCreate = jest.fn();

const mockProgramFindById = jest.fn();
const mockProgramFindByIdAndUpdate = jest.fn();
const mockProgramFindByIdAndDelete = jest.fn();
const mockProgramUpdateMany = jest.fn();

const mockTestCountDocuments = jest.fn();
const mockAssignmentDeleteMany = jest.fn();
const mockSubjectCountDocuments = jest.fn();

jest.mock("../models/Academic/subject.model", () => ({
  findById: (...a) => mockSubjectFindById(...a),
  findByIdAndDelete: (...a) => mockSubjectFindByIdAndDelete(...a),
  create: (...a) => mockSubjectCreate(...a),
  findOne: (...a) => mockSubjectFindOne(...a),
  countDocuments: (...a) => mockSubjectCountDocuments(...a),
}));

jest.mock("../models/Academic/program.model", () => ({
  findById: (...a) => mockProgramFindById(...a),
  findByIdAndUpdate: (...a) => mockProgramFindByIdAndUpdate(...a),
  findByIdAndDelete: (...a) => mockProgramFindByIdAndDelete(...a),
  updateMany: (...a) => mockProgramUpdateMany(...a),
}));

jest.mock("../models/Academic/test.model", () => ({
  countDocuments: (...a) => mockTestCountDocuments(...a),
}));

jest.mock("../models/Academic/assignment.model", () => ({
  deleteMany: (...a) => mockAssignmentDeleteMany(...a),
}));

jest.mock("../models/Academic/class.model", () => ({
  find: jest.fn().mockResolvedValue([]),
}));

const { deleteSubjectService } = require("../services/academic/subject.service");
const { deleteProgramService } = require("../services/academic/program.service");
const { captureServiceResponse } = require("../utils/viewServiceResponse");

const SUBJECT_ID = "subject-del-1";
const PROGRAM_ID = "program-del-1";

beforeEach(() => {
  jest.clearAllMocks();
});

// ── deleteSubjectService via captureServiceResponse ──────────────────────────
describe("deleteSubjectService – via captureServiceResponse", () => {
  test("successful delete → result.ok is true, result.message is null", async () => {
    mockSubjectFindById.mockResolvedValue({ _id: SUBJECT_ID, name: "Test Subj" });
    mockTestCountDocuments.mockResolvedValue(0);
    mockAssignmentDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockSubjectFindByIdAndDelete.mockResolvedValue({ _id: SUBJECT_ID, name: "Test Subj" });
    mockProgramUpdateMany.mockResolvedValue({ modifiedCount: 0 });

    const { res: cap, result } = captureServiceResponse();
    await deleteSubjectService(SUBJECT_ID, cap);

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(mockSubjectFindByIdAndDelete).toHaveBeenCalledWith(SUBJECT_ID);
  });

  test("subject not found → result.ok is false with 404 message", async () => {
    mockSubjectFindById.mockResolvedValue(null);

    const { res: cap, result } = captureServiceResponse();
    await deleteSubjectService("nonexistent", cap);

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.message).toBe("Subject not found");
  });

  test("tests still reference subject → result.ok is false with 403 message", async () => {
    mockSubjectFindById.mockResolvedValue({ _id: SUBJECT_ID, name: "Math" });
    mockTestCountDocuments.mockResolvedValue(3);

    const { res: cap, result } = captureServiceResponse();
    await deleteSubjectService(SUBJECT_ID, cap);

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.message).toMatch(/3 test\(s\) still reference/);
    // Subject must NOT have been deleted
    expect(mockSubjectFindByIdAndDelete).not.toHaveBeenCalled();
  });
});

// ── deleteProgramService via captureServiceResponse ──────────────────────────
describe("deleteProgramService – via captureServiceResponse", () => {
  test("successful delete → result.ok is true, result.message is null", async () => {
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_ID, name: "Test Prog" });
    mockSubjectCountDocuments.mockResolvedValue(0);
    mockProgramFindByIdAndDelete.mockResolvedValue({ _id: PROGRAM_ID, name: "Test Prog" });

    const { res: cap, result } = captureServiceResponse();
    await deleteProgramService(PROGRAM_ID, cap);

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(mockProgramFindByIdAndDelete).toHaveBeenCalledWith(PROGRAM_ID);
  });

  test("program not found → result.ok is false with 404 message", async () => {
    mockProgramFindById.mockResolvedValue(null);

    const { res: cap, result } = captureServiceResponse();
    await deleteProgramService("nonexistent", cap);

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(404);
    expect(result.message).toBe("Program not found");
  });

  test("subjects still belong to program → result.ok is false with 403 message", async () => {
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_ID, name: "Matric" });
    mockSubjectCountDocuments.mockResolvedValue(2);

    const { res: cap, result } = captureServiceResponse();
    await deleteProgramService(PROGRAM_ID, cap);

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.message).toMatch(/2 subject\(s\) still belong/);
    // Program must NOT have been deleted
    expect(mockProgramFindByIdAndDelete).not.toHaveBeenCalled();
  });
});
