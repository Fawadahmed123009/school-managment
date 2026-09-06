/**
 * Tests deleteSubjectService — when a subject is deleted its _id must also be
 * removed from every Program.subjects array that referenced it.
 *
 *   • A successful delete calls Subject.findByIdAndDelete AND
 *     Program.updateMany with $pull to clean up the reference.
 *   • If the subject does not exist (findById returns null),
 *     Program.updateMany must NOT be called.
 *
 * Both Subject and Program models are mocked at the data layer so the real
 * service logic executes without a database.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockSubjectFindById = jest.fn();
const mockSubjectFindByIdAndDelete = jest.fn();
const mockSubjectCreate = jest.fn();
const mockSubjectFindOne = jest.fn();

const mockProgramFindById = jest.fn();
const mockProgramFindByIdAndUpdate = jest.fn();
const mockProgramUpdateMany = jest.fn();

const mockTestCountDocuments = jest.fn();
const mockAssignmentDeleteMany = jest.fn();

jest.mock("../models/Academic/subject.model", () => ({
  findById: (...a) => mockSubjectFindById(...a),
  findByIdAndDelete: (...a) => mockSubjectFindByIdAndDelete(...a),
  create: (...a) => mockSubjectCreate(...a),
  findOne: (...a) => mockSubjectFindOne(...a),
}));

jest.mock("../models/Academic/program.model", () => ({
  findById: (...a) => mockProgramFindById(...a),
  findByIdAndUpdate: (...a) => mockProgramFindByIdAndUpdate(...a),
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

const {
  createSubjectService,
  deleteSubjectService,
} = require("../services/academic/subject.service");

const ADMIN_ID = "admin-1";
const PROGRAM_ID = "program-1";
const SUBJECT_ID = "subject-abc";

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("deleteSubjectService – Program cleanup", () => {
  test("pulls the deleted subject's _id from Program.subjects", async () => {
    // Simulate a previously-created subject document
    const deletedSubject = { _id: SUBJECT_ID, name: "Mathematics" };
    mockSubjectFindById.mockResolvedValue(deletedSubject);
    mockSubjectFindByIdAndDelete.mockResolvedValue(deletedSubject);
    mockTestCountDocuments.mockResolvedValue(0);
    mockAssignmentDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockProgramUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    const res = mockRes();
    await deleteSubjectService(SUBJECT_ID, res);

    // Subject was deleted
    expect(mockSubjectFindByIdAndDelete).toHaveBeenCalledWith(SUBJECT_ID);

    // Program was updated to remove the subject reference
    expect(mockProgramUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockProgramUpdateMany).toHaveBeenCalledWith(
      { subjects: SUBJECT_ID },
      { $pull: { subjects: SUBJECT_ID } }
    );
  });

  test("does NOT call Program.updateMany when subject does not exist", async () => {
    mockSubjectFindById.mockResolvedValue(null);

    const res = mockRes();
    await deleteSubjectService("nonexistent-id", res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockProgramUpdateMany).not.toHaveBeenCalled();
  });
});

describe("create-then-delete integration (mocked models)", () => {
  test("after create → delete, Program no longer references the subject", async () => {
    // ── Step 1: createSubjectService pushes the new subject into Program ──
    mockSubjectFindOne.mockResolvedValue(null); // no duplicate
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_ID, name: "Matric" });
    mockSubjectCreate.mockImplementation(async (doc) => ({
      _id: SUBJECT_ID,
      ...doc,
    }));
    mockProgramFindByIdAndUpdate.mockResolvedValue({});

    const mockResObj = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await createSubjectService(
      { name: "Physics", description: "Intro", appliesTo: [] },
      PROGRAM_ID,
      ADMIN_ID,
      mockResObj
    );

    // Verify the subject was pushed into the Program
    expect(mockProgramFindByIdAndUpdate).toHaveBeenCalledWith(PROGRAM_ID, {
      $push: { subjects: SUBJECT_ID },
    });

    // ── Step 2: deleteSubjectService removes the subject + pulls from Program ──
    mockSubjectFindById.mockResolvedValue({ _id: SUBJECT_ID, name: "Physics" });
    mockSubjectFindByIdAndDelete.mockResolvedValue({ _id: SUBJECT_ID, name: "Physics" });
    mockTestCountDocuments.mockResolvedValue(0);
    mockAssignmentDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mockProgramUpdateMany.mockResolvedValue({ modifiedCount: 1 });

    const res = mockRes();
    await deleteSubjectService(SUBJECT_ID, res);

    expect(mockSubjectFindByIdAndDelete).toHaveBeenCalledWith(SUBJECT_ID);

    // The $pull call is the critical assertion: Program.subjects must no
    // longer contain the deleted subject's ObjectId.
    expect(mockProgramUpdateMany).toHaveBeenCalledWith(
      { subjects: SUBJECT_ID },
      { $pull: { subjects: SUBJECT_ID } }
    );
  });
});
