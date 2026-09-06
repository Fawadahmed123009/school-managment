/**
 * Tests program-scoped subject uniqueness.
 *
 * Verifies:
 *   1. Creating "Math" under Program A succeeds.
 *   2. Creating "Math" under Program B also succeeds (different program).
 *   3. Creating "Math" under Program A again FAILS (duplicate within same program).
 *   4. Updating a subject's name to match another subject in the SAME program fails.
 *   5. Updating a subject's name to match a subject in a DIFFERENT program succeeds.
 *
 * Models are mocked at the data layer so the real service logic executes
 * without a live database.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockSubjectCreate = jest.fn();
const mockSubjectFindOne = jest.fn();
const mockSubjectFindById = jest.fn();

const mockProgramFindById = jest.fn();
const mockProgramFindByIdAndUpdate = jest.fn();

const mockClassLevelFind = jest.fn();

jest.mock("../models/Academic/subject.model", () => ({
  create: (...a) => mockSubjectCreate(...a),
  findOne: (...a) => mockSubjectFindOne(...a),
  findById: (...a) => mockSubjectFindById(...a),
}));

jest.mock("../models/Academic/program.model", () => ({
  findById: (...a) => mockProgramFindById(...a),
  findByIdAndUpdate: (...a) => mockProgramFindByIdAndUpdate(...a),
}));

jest.mock("../models/Academic/class.model", () => ({
  find: (...a) => mockClassLevelFind(...a),
}));

const {
  createSubjectService,
  updateSubjectService,
} = require("../services/academic/subject.service");

// ── Constants ────────────────────────────────────────────────────────────────
const ADMIN_ID = "admin-001";
const PROGRAM_MATRIC = "program-matric";
const PROGRAM_INTER = "program-inter";
const SUBJECT_MATH_MATRIC = "subject-math-matric";
const SUBJECT_MATH_INTER = "subject-math-inter";

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeMockRes() {
  const res = {
    _statusCode: null,
    _body: null,
    status: jest.fn(function (code) {
      res._statusCode = code;
      return res;
    }),
    json: jest.fn(function (body) {
      res._body = body;
      return res;
    }),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClassLevelFind.mockResolvedValue([]);
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 1: Create "Math" under Matriculation — should succeed
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 1 – Create 'Math' under Matriculation", () => {
  test("PASS: subject created with program set to Matriculation", async () => {
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_MATRIC, name: "Matriculation" });
    mockSubjectFindOne.mockResolvedValue(null); // no duplicate
    mockSubjectCreate.mockImplementation(async (doc) => ({
      _id: SUBJECT_MATH_MATRIC,
      ...doc,
    }));
    mockProgramFindByIdAndUpdate.mockResolvedValue({});

    const res = makeMockRes();
    await createSubjectService(
      { name: "Math", description: "Mathematics", appliesTo: [] },
      PROGRAM_MATRIC,
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(200);
    expect(res._body.status).toBe("success");
    expect(mockSubjectCreate).toHaveBeenCalledTimes(1);

    // Verify program was stored on the subject
    const created = mockSubjectCreate.mock.calls[0][0];
    expect(created.program).toBe(PROGRAM_MATRIC);
    expect(created.name).toBe("Math");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 2: Create "Math" under Intermediate — should ALSO succeed
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 2 – Create 'Math' under Intermediate (different program)", () => {
  test("PASS: same name allowed under a different program", async () => {
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_INTER, name: "Intermediate" });
    // findOne with { name: "Math", program: PROGRAM_INTER } returns null
    mockSubjectFindOne.mockResolvedValue(null);
    mockSubjectCreate.mockImplementation(async (doc) => ({
      _id: SUBJECT_MATH_INTER,
      ...doc,
    }));
    mockProgramFindByIdAndUpdate.mockResolvedValue({});

    const res = makeMockRes();
    await createSubjectService(
      { name: "Math", description: "Mathematics", appliesTo: [] },
      PROGRAM_INTER,
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(200);
    expect(res._body.status).toBe("success");
    expect(mockSubjectCreate).toHaveBeenCalledTimes(1);

    const created = mockSubjectCreate.mock.calls[0][0];
    expect(created.program).toBe(PROGRAM_INTER);

    // Verify the duplicate check was scoped to the correct program
    expect(mockSubjectFindOne).toHaveBeenCalledWith({
      name: "Math",
      program: PROGRAM_INTER,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 3: Create "Math" under Matriculation AGAIN — should FAIL
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 3 – Create 'Math' under Matriculation again (duplicate)", () => {
  test("FAIL: duplicate name within same program is rejected", async () => {
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_MATRIC, name: "Matriculation" });
    // findOne returns the existing Math subject in Matriculation
    mockSubjectFindOne.mockResolvedValue({
      _id: SUBJECT_MATH_MATRIC,
      name: "Math",
      program: PROGRAM_MATRIC,
    });

    const res = makeMockRes();
    await createSubjectService(
      { name: "Math", description: "Mathematics", appliesTo: [] },
      PROGRAM_MATRIC,
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(402);
    expect(res._body.status).toBe("failed");
    expect(res._body.message).toMatch(/already exists in this program/i);
    expect(mockSubjectCreate).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 4: Update subject name to match another in the SAME program — FAIL
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 4 – Update subject name to a duplicate within the same program", () => {
  test("FAIL: renaming to an existing name in the same program is rejected", async () => {
    // Existing subject being updated: "Physics" in Matriculation
    mockSubjectFindById.mockResolvedValue({
      _id: "subject-physics-matric",
      name: "Physics",
      program: PROGRAM_MATRIC,
    });

    // Another subject named "Math" already exists in Matriculation
    mockSubjectFindOne.mockResolvedValue({
      _id: SUBJECT_MATH_MATRIC,
      name: "Math",
      program: PROGRAM_MATRIC,
    });

    const res = makeMockRes();
    await updateSubjectService(
      { name: "Math", description: "Renamed to Math", appliesTo: [] },
      "subject-physics-matric",
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(402);
    expect(res._body.status).toBe("failed");
    expect(res._body.message).toMatch(/already exists in this program/i);

    // Verify the duplicate check was scoped by program
    expect(mockSubjectFindOne).toHaveBeenCalledWith({
      name: "Math",
      program: PROGRAM_MATRIC,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 5: Update subject name to match one in a DIFFERENT program — PASS
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 5 – Update subject name to match one in a different program", () => {
  test("PASS: renaming to a name that exists in another program is allowed", async () => {
    // Existing subject being updated: "Physics" in Matriculation
    mockSubjectFindById.mockResolvedValue({
      _id: "subject-physics-matric",
      name: "Physics",
      program: PROGRAM_MATRIC,
    });

    // No subject named "Math" exists in Matriculation (it exists in Intermediate,
    // but that's a different program)
    mockSubjectFindOne.mockResolvedValue(null);

    const mongooseFindByIdAndUpdate = jest.fn().mockResolvedValue({
      _id: "subject-physics-matric",
      name: "Math",
      program: PROGRAM_MATRIC,
    });
    const Subject = require("../models/Academic/subject.model");
    Subject.findByIdAndUpdate = mongooseFindByIdAndUpdate;

    const res = makeMockRes();
    await updateSubjectService(
      { name: "Math", description: "Renamed", appliesTo: [] },
      "subject-physics-matric",
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(200);
    expect(res._body.status).toBe("success");

    // Verify the duplicate check was scoped to Matriculation (not global)
    expect(mockSubjectFindOne).toHaveBeenCalledWith({
      name: "Math",
      program: PROGRAM_MATRIC,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 6: Verify findOne query shape — must include program
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 6 – Duplicate-check query must include program field", () => {
  test("createSubjectService queries with { name, program }", async () => {
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_MATRIC, name: "Matriculation" });
    mockSubjectFindOne.mockResolvedValue(null);
    mockSubjectCreate.mockImplementation(async (doc) => ({ _id: "new-id", ...doc }));
    mockProgramFindByIdAndUpdate.mockResolvedValue({});

    const res = makeMockRes();
    await createSubjectService(
      { name: "English", description: "English Subject", appliesTo: [] },
      PROGRAM_MATRIC,
      ADMIN_ID,
      res
    );

    // The critical assertion: findOne must filter by BOTH name AND program
    expect(mockSubjectFindOne).toHaveBeenCalledWith({
      name: "English",
      program: PROGRAM_MATRIC,
    });
  });
});
