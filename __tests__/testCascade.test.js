/**
 * Tests for the three-level cascade API endpoints:
 *   - GET /tests/cascade/classes
 *   - GET /tests/cascade/subjects?classLevel=xxx[,yyy,...]
 *   - GET /tests/cascade/tests?classLevel=xxx[,yyy,...]&subject=zzz
 *
 * Verifies that:
 *   • Each endpoint returns only data the teacher is actually assigned to.
 *   • Multi-class selection returns the UNION of subjects with accurate
 *     class-level annotations.
 *   • Security: teachers cannot fetch subjects/tests for classes they're
 *     not assigned to (including partial — if any one class is unassigned
 *     the whole request is rejected at Level 2).
 *   • Level 3 uses $in so a test covering at least one selected class appears.
 *   • Roster scoping: a test covering only one of several selected classes
 *     still shows only that class's students.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAssignmentFind = jest.fn();
const mockAssignmentFindOne = jest.fn();
const mockAssignmentDistinct = jest.fn();
const mockClassLevelFind = jest.fn();
const mockSubjectFind = jest.fn();
const mockSubjectDistinct = jest.fn();
const mockTestFind = jest.fn();

jest.mock("../models/Academic/assignment.model", () => ({
  find: mockAssignmentFind,
  findOne: mockAssignmentFindOne,
  distinct: mockAssignmentDistinct,
}));

jest.mock("../models/Academic/class.model", () => ({
  find: mockClassLevelFind,
}));

jest.mock("../models/Academic/subject.model", () => ({
  find: mockSubjectFind,
  distinct: mockSubjectDistinct,
}));

jest.mock("../models/Academic/test.model", () => ({
  find: mockTestFind,
}));

// Mock responseStatus to capture calls
const mockResponseStatus = jest.fn((res, status, statusText, data) => {
  res.status(status).json({ status: statusText, data, message: data });
});

jest.mock("../handlers/responseStatus.handler", () => mockResponseStatus);

const {
  getTeacherAssignedClassesService,
  getTeacherAssignedSubjectsService,
  getTeacherScopedTestsByClassSubjectService,
} = require("../services/academic/test.service");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ── Test Data ────────────────────────────────────────────────────────────────

const TEACHER_A = "teacher-a-id";
const TEACHER_B = "teacher-b-id";
const CLASS_9_GIRLS = "class-9-bio-girls";
const CLASS_10_PREMED = "class-10-premed";
const CLASS_11_ENGINEERING = "class-11-eng";
const SUBJECT_MATH = "sub-math";
const SUBJECT_SCIENCE = "sub-science";
const SUBJECT_PHYSICS = "sub-physics";

// Additional classes for the 8-class regression test
const CLASS_9_BOYS = "class-9-bio-boys";
const CLASS_10_PREENG = "class-10-preeng";
const CLASS_11_PREMED = "class-11-premed";
const CLASS_11_PREENG = "class-11-preeng";
const CLASS_12_PREMED = "class-12-premed";
const CLASS_12_PREENG = "class-12-preeng";

// ── Tests: Level 1 - getTeacherAssignedClassesService ────────────────────────

describe("Cascade Level 1: getTeacherAssignedClassesService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns only classes the teacher is assigned to", async () => {
    mockAssignmentFind.mockReturnValue({
      distinct: jest.fn().mockResolvedValue([CLASS_9_GIRLS, CLASS_10_PREMED]),
    });

    const expectedClasses = [
      { _id: CLASS_9_GIRLS, name: "9th Biology Girls", gradeLevel: "9", group: "Biology" },
      { _id: CLASS_10_PREMED, name: "10th Pre-Med", gradeLevel: "10", group: "Pre-Medical" },
    ];
    mockClassLevelFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue(expectedClasses),
      }),
    });

    const res = mockRes();
    await getTeacherAssignedClassesService(TEACHER_A, res);

    expect(res.json).toHaveBeenCalled();
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(2);
  });

  test("returns empty array when teacher has no assignments", async () => {
    mockAssignmentFind.mockReturnValue({
      distinct: jest.fn().mockResolvedValue([]),
    });

    const res = mockRes();
    await getTeacherAssignedClassesService(TEACHER_A, res);

    expect(res.json).toHaveBeenCalled();
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(0);
  });
});

// ── Tests: Level 2 - getTeacherAssignedSubjectsService ───────────────────────

describe("Cascade Level 2: getTeacherAssignedSubjectsService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns subjects for a single class the teacher is assigned to", async () => {
    // Teacher A teaches Math AND Science to Class 9 Girls
    mockAssignmentDistinct.mockResolvedValue([CLASS_9_GIRLS]); // 1 distinct class assigned
    mockAssignmentFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { subject: SUBJECT_MATH, classLevel: CLASS_9_GIRLS },
          { subject: SUBJECT_SCIENCE, classLevel: CLASS_9_GIRLS },
        ]),
      }),
    });

    const expectedSubjects = [
      { _id: SUBJECT_MATH, name: "Mathematics" },
      { _id: SUBJECT_SCIENCE, name: "Science" },
    ];
    mockSubjectFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue(expectedSubjects),
      }),
    });

    const res = mockRes();
    await getTeacherAssignedSubjectsService(TEACHER_A, CLASS_9_GIRLS, res);

    expect(res.json).toHaveBeenCalled();
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(2);
    // Each subject should have classLevels annotation
    expect(response.data[0].classLevels).toContain(CLASS_9_GIRLS);
    expect(response.data[1].classLevels).toContain(CLASS_9_GIRLS);
  });

  test("returns empty array when teacher has no subjects for that class", async () => {
    mockAssignmentDistinct.mockResolvedValue([CLASS_9_GIRLS]); // Assigned to class
    mockAssignmentFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]), // But no assignments
      }),
    });

    const res = mockRes();
    await getTeacherAssignedSubjectsService(TEACHER_A, CLASS_9_GIRLS, res);

    expect(res.json).toHaveBeenCalled();
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(0);
  });

  test("returns 400 when classLevel is missing", async () => {
    const res = mockRes();
    await getTeacherAssignedSubjectsService(TEACHER_A, null, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("failed");
  });

  test("SECURITY: rejects when teacher is NOT assigned to the requested class", async () => {
    // Teacher A tries to access Class 11 Engineering (not assigned)
    mockAssignmentDistinct.mockResolvedValue([]); // 0 distinct classes assigned

    const res = mockRes();
    await getTeacherAssignedSubjectsService(TEACHER_A, CLASS_11_ENGINEERING, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("failed");
    expect(response.message).toMatch(/not assigned/i);
  });
});

// ── Tests: Level 2 — Multi-class union ───────────────────────────────────────

describe("Cascade Level 2: multi-class union with class annotations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns union of subjects across two selected classes with correct annotations", async () => {
    // Teacher A teaches:
    //   Math → Class 9 Girls
    //   Science → Class 9 Girls
    //   Math → Class 10 Pre-Med
    //   Physics → Class 10 Pre-Med
    // Union should be: Math (9, 10), Physics (10), Science (9)
    mockAssignmentDistinct.mockResolvedValue([CLASS_9_GIRLS, CLASS_10_PREMED]); // 2 distinct classes assigned
    mockAssignmentFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { subject: SUBJECT_MATH, classLevel: CLASS_9_GIRLS },
          { subject: SUBJECT_SCIENCE, classLevel: CLASS_9_GIRLS },
          { subject: SUBJECT_MATH, classLevel: CLASS_10_PREMED },
          { subject: SUBJECT_PHYSICS, classLevel: CLASS_10_PREMED },
        ]),
      }),
    });

    const expectedSubjects = [
      { _id: SUBJECT_MATH, name: "Mathematics" },
      { _id: SUBJECT_PHYSICS, name: "Physics" },
      { _id: SUBJECT_SCIENCE, name: "Science" },
    ];
    mockSubjectFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue(expectedSubjects),
      }),
    });

    const res = mockRes();
    await getTeacherAssignedSubjectsService(
      TEACHER_A,
      `${CLASS_9_GIRLS},${CLASS_10_PREMED}`,
      res
    );

    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(3);

    // Math should be annotated with BOTH classes
    const math = response.data.find((s) => s._id === SUBJECT_MATH);
    expect(math.classLevels).toContain(CLASS_9_GIRLS);
    expect(math.classLevels).toContain(CLASS_10_PREMED);
    expect(math.classLevels).toHaveLength(2);

    // Science should be annotated with only Class 9
    const science = response.data.find((s) => s._id === SUBJECT_SCIENCE);
    expect(science.classLevels).toContain(CLASS_9_GIRLS);
    expect(science.classLevels).not.toContain(CLASS_10_PREMED);

    // Physics should be annotated with only Class 10
    const physics = response.data.find((s) => s._id === SUBJECT_PHYSICS);
    expect(physics.classLevels).toContain(CLASS_10_PREMED);
    expect(physics.classLevels).not.toContain(CLASS_9_GIRLS);
  });

  test("SECURITY: rejects when teacher is assigned to some but not all selected classes", async () => {
    // Teacher A is assigned to Class 9 Girls but NOT Class 11 Engineering
    // Requesting both → should be rejected (distinct returns 1, but 2 requested)
    mockAssignmentDistinct.mockResolvedValue([CLASS_9_GIRLS]); // only 1 of 2 distinct classes assigned

    const res = mockRes();
    await getTeacherAssignedSubjectsService(
      TEACHER_A,
      `${CLASS_9_GIRLS},${CLASS_11_ENGINEERING}`,
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("failed");
    expect(response.message).toMatch(/not assigned/i);
  });

  test("works with comma-separated string containing a single class", async () => {
    mockAssignmentDistinct.mockResolvedValue([CLASS_9_GIRLS]);
    mockAssignmentFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { subject: SUBJECT_MATH, classLevel: CLASS_9_GIRLS },
        ]),
      }),
    });

    mockSubjectFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue([{ _id: SUBJECT_MATH, name: "Mathematics" }]),
      }),
    });

    const res = mockRes();
    await getTeacherAssignedSubjectsService(TEACHER_A, CLASS_9_GIRLS, res);

    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(1);
    expect(response.data[0].classLevels).toEqual([CLASS_9_GIRLS]);
  });
});

// ── Tests: Level 3 - getTeacherScopedTestsByClassSubjectService ──────────────

describe("Cascade Level 3: getTeacherScopedTestsByClassSubjectService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns tests matching subject AND at least one selected class (single class)", async () => {
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });

    const expectedTests = [
      { _id: "test-1", name: "Math Quiz 1", subject: { _id: SUBJECT_MATH, name: "Math" }, classLevels: [{ _id: CLASS_9_GIRLS, name: "9th Bio Girls" }] },
      { _id: "test-2", name: "Math Quiz 2", subject: { _id: SUBJECT_MATH, name: "Math" }, classLevels: [{ _id: CLASS_9_GIRLS, name: "9th Bio Girls" }] },
    ];
    mockTestFind.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            sort: jest.fn().mockResolvedValue(expectedTests),
          }),
        }),
      }),
    });

    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService(TEACHER_A, CLASS_9_GIRLS, SUBJECT_MATH, res);

    expect(res.json).toHaveBeenCalled();
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(2);

    // Verify the Test.find was called with $in for classLevels
    const findCall = mockTestFind.mock.calls[0][0];
    expect(findCall.classLevels).toEqual({ $in: [CLASS_9_GIRLS] });
  });

  test("returns tests covering ANY of the selected classes (multi-class $in)", async () => {
    // Teacher is assigned to Math for both classes
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });

    const expectedTests = [
      { _id: "test-1", name: "Math Quiz 9A", classLevels: [{ _id: CLASS_9_GIRLS, name: "9A" }] },
      { _id: "test-2", name: "Math Quiz 10", classLevels: [{ _id: CLASS_10_PREMED, name: "10PM" }] },
      { _id: "test-3", name: "Math Combined", classLevels: [{ _id: CLASS_9_GIRLS, name: "9A" }, { _id: CLASS_10_PREMED, name: "10PM" }] },
    ];
    mockTestFind.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            sort: jest.fn().mockResolvedValue(expectedTests),
          }),
        }),
      }),
    });

    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService(
      TEACHER_A,
      `${CLASS_9_GIRLS},${CLASS_10_PREMED}`,
      SUBJECT_MATH,
      res
    );

    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(3);

    // Verify $in query
    const findCall = mockTestFind.mock.calls[0][0];
    expect(findCall.classLevels).toEqual({ $in: [CLASS_9_GIRLS, CLASS_10_PREMED] });
    expect(findCall.subject).toBe(SUBJECT_MATH);
  });

  test("SECURITY: rejects when teacher is NOT assigned to this subject for any selected class", async () => {
    mockAssignmentFindOne.mockResolvedValue(null);

    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService(
      TEACHER_A,
      `${CLASS_9_GIRLS},${CLASS_10_PREMED}`,
      SUBJECT_PHYSICS,
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("failed");
    expect(response.message).toMatch(/not assigned/i);
  });

  test("SECURITY: teacher B cannot access teacher A's class+subject combo", async () => {
    mockAssignmentFindOne.mockResolvedValue(null);

    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService(TEACHER_B, CLASS_9_GIRLS, SUBJECT_MATH, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("returns 400 when classLevel or subject is missing", async () => {
    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService(TEACHER_A, null, SUBJECT_MATH, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("returns empty array when no tests exist for that subject + classes", async () => {
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });
    mockTestFind.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            sort: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });

    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService(TEACHER_A, CLASS_9_GIRLS, SUBJECT_MATH, res);

    expect(res.json).toHaveBeenCalled();
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(0);
  });
});

// ── Tests: Multi-subject scenario (teacher teaches Math AND Science to same class) ──

describe("Cascade: Teacher with multiple subjects for same class", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("teacher assigned to Math AND Science for Class 9 sees both subjects in cascade", async () => {
    mockAssignmentDistinct.mockResolvedValue([CLASS_9_GIRLS]);
    mockAssignmentFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { subject: SUBJECT_MATH, classLevel: CLASS_9_GIRLS },
          { subject: SUBJECT_SCIENCE, classLevel: CLASS_9_GIRLS },
        ]),
      }),
    });

    const expectedSubjects = [
      { _id: SUBJECT_MATH, name: "Mathematics" },
      { _id: SUBJECT_SCIENCE, name: "Science" },
    ];
    mockSubjectFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue(expectedSubjects),
      }),
    });

    const res = mockRes();
    await getTeacherAssignedSubjectsService(TEACHER_A, CLASS_9_GIRLS, res);

    const response = res.json.mock.calls[0][0];
    expect(response.data).toHaveLength(2);
    expect(response.data.map(s => s.name)).toContain("Mathematics");
    expect(response.data.map(s => s.name)).toContain("Science");
  });

  test("each subject returns only its own tests (not the other subject's tests)", async () => {
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-math" });
    const mathTests = [{ _id: "test-math-1", name: "Math Quiz" }];
    mockTestFind.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            sort: jest.fn().mockResolvedValue(mathTests),
          }),
        }),
      }),
    });

    const res1 = mockRes();
    await getTeacherScopedTestsByClassSubjectService(TEACHER_A, CLASS_9_GIRLS, SUBJECT_MATH, res1);
    const mathResponse = res1.json.mock.calls[0][0];
    expect(mathResponse.data).toHaveLength(1);
    expect(mathResponse.data[0].name).toBe("Math Quiz");

    jest.clearAllMocks();
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-science" });
    const scienceTests = [{ _id: "test-sci-1", name: "Science Quiz" }];
    mockTestFind.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            sort: jest.fn().mockResolvedValue(scienceTests),
          }),
        }),
      }),
    });

    const res2 = mockRes();
    await getTeacherScopedTestsByClassSubjectService(TEACHER_A, CLASS_9_GIRLS, SUBJECT_SCIENCE, res2);
    const scienceResponse = res2.json.mock.calls[0][0];
    expect(scienceResponse.data).toHaveLength(1);
    expect(scienceResponse.data[0].name).toBe("Science Quiz");
  });
});

// ── Regression: 8-class distinct-count check ────────────────────────────────
// Bug: countDocuments counted assignment docs, not distinct classes.
// A teacher with 2 subjects × 4 classes = 8 docs would PASS a check for 8
// classes even though they're only assigned to 4. Conversely, selecting all
// 8 classes when only assigned to 4 must correctly return 403.

describe("Regression: distinct-class security check with 8 classes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const all8Classes = [
    CLASS_9_GIRLS, CLASS_9_BOYS,
    CLASS_10_PREMED, CLASS_10_PREENG,
    CLASS_11_PREMED, CLASS_11_PREENG,
    CLASS_12_PREMED, CLASS_12_PREENG,
  ].join(",");

  test("SECURITY: teacher with 2 subjects × 4 classes (8 docs) is REJECTED when selecting all 8 classes", async () => {
    // Teacher is assigned to Math+Science for 4 classes only.
    // distinct("classLevel") returns 4 unique class IDs, but 8 were requested.
    // Old countDocuments would return 8 (2 subjects × 4 classes) → passes (WRONG).
    // New distinct returns 4 → 4 < 8 → 403 (CORRECT).
    mockAssignmentDistinct.mockResolvedValue([
      CLASS_9_GIRLS, CLASS_9_BOYS,
      CLASS_10_PREMED, CLASS_10_PREENG,
    ]);

    const res = mockRes();
    await getTeacherAssignedSubjectsService(TEACHER_A, all8Classes, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("failed");
    expect(response.message).toMatch(/not assigned/i);
  });

  test("PASSES when teacher is genuinely assigned to all 8 classes", async () => {
    // Teacher has at least one assignment for each of the 8 classes
    mockAssignmentDistinct.mockResolvedValue([
      CLASS_9_GIRLS, CLASS_9_BOYS,
      CLASS_10_PREMED, CLASS_10_PREENG,
      CLASS_11_PREMED, CLASS_11_PREENG,
      CLASS_12_PREMED, CLASS_12_PREENG,
    ]);

    mockAssignmentFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { subject: SUBJECT_MATH, classLevel: CLASS_9_GIRLS },
          { subject: SUBJECT_MATH, classLevel: CLASS_9_BOYS },
          { subject: SUBJECT_MATH, classLevel: CLASS_10_PREMED },
          { subject: SUBJECT_MATH, classLevel: CLASS_10_PREENG },
          { subject: SUBJECT_MATH, classLevel: CLASS_11_PREMED },
          { subject: SUBJECT_MATH, classLevel: CLASS_11_PREENG },
          { subject: SUBJECT_MATH, classLevel: CLASS_12_PREMED },
          { subject: SUBJECT_MATH, classLevel: CLASS_12_PREENG },
        ]),
      }),
    });

    const expectedSubjects = [
      { _id: SUBJECT_MATH, name: "Mathematics" },
    ];
    mockSubjectFind.mockReturnValue({
      select: jest.fn().mockReturnValue({
        sort: jest.fn().mockResolvedValue(expectedSubjects),
      }),
    });

    const res = mockRes();
    await getTeacherAssignedSubjectsService(TEACHER_A, all8Classes, res);

    expect(res.json).toHaveBeenCalled();
    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(1);
    expect(response.data[0].name).toBe("Mathematics");
    expect(response.data[0].classLevels).toHaveLength(8);
  });
});
