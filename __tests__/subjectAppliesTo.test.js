/**
 * E2E test: Subject appliesTo multi-class behavior — specific + wholeGrade
 *
 * Verifies:
 *   1. Creating a Subject with multiple appliesTo entries (specific ClassLevel refs)
 *      saves correctly.
 *   2. Assignment creation succeeds for classLevels that match the subject's appliesTo
 *      entries (both specific and wholeGrade).
 *   3. Assignment creation FAILS for a classLevel that is NOT in the appliesTo array.
 *   4. wholeGrade entry matches ANY ClassLevel with that gradeLevel, regardless of group.
 *   5. A specific entry does NOT match a class outside the exact ClassLevel referenced.
 *   6. A new ClassLevel created after the wholeGrade entry still matches it.
 *
 * Models are mocked at the data layer so the real service logic executes without a
 * live database, following the established test pattern in this project.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockSubjectCreate = jest.fn();
const mockSubjectFindOne = jest.fn();
const mockSubjectFindById = jest.fn();
const mockSubjectFind = jest.fn();

const mockProgramFindById = jest.fn();
const mockProgramFindByIdAndUpdate = jest.fn();

const mockClassLevelFindById = jest.fn();
const mockClassLevelFind = jest.fn();

const mockAssignmentFindOne = jest.fn();
const mockAssignmentCreate = jest.fn();
const mockAssignmentFind = jest.fn();

const mockTestCreate = jest.fn();

jest.mock("../models/Academic/subject.model", () => ({
  create: (...a) => mockSubjectCreate(...a),
  findOne: (...a) => mockSubjectFindOne(...a),
  findById: (...a) => mockSubjectFindById(...a),
  find: (...a) => mockSubjectFind(...a),
}));

jest.mock("../models/Academic/program.model", () => ({
  findById: (...a) => mockProgramFindById(...a),
  findByIdAndUpdate: (...a) => mockProgramFindByIdAndUpdate(...a),
}));

jest.mock("../models/Academic/class.model", () => ({
  findById: (...a) => mockClassLevelFindById(...a),
  find: (...a) => mockClassLevelFind(...a),
}));

jest.mock("../models/Academic/assignment.model", () => ({
  findOne: (...a) => mockAssignmentFindOne(...a),
  create: (...a) => mockAssignmentCreate(...a),
  find: (...a) => mockAssignmentFind(...a),
}));

jest.mock("../models/Academic/test.model", () => ({
  create: (...a) => mockTestCreate(...a),
}));

jest.mock("../models/Academic/testSession.model", () => ({
  findById: jest.fn(),
}));

jest.mock("../models/Students/students.model", () => ({
  find: jest.fn(),
}));

jest.mock("../models/Academic/testResult.model", () => ({
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

// ── Service imports (after mocks) ────────────────────────────────────────────
const {
  createSubjectService,
  getAllSubjectsService,
  getSubjectsService,
  updateSubjectService,
} = require("../services/academic/subject.service");

const {
  createAssignmentService,
} = require("../services/academic/assignment.service");

const {
  createTestService,
} = require("../services/academic/test.service");

// ── Constants ────────────────────────────────────────────────────────────────
const ADMIN_ID = "admin-001";
const PROGRAM_ID = "program-001";
const SUBJECT_ID = "subject-multi-001";
const TEACHER_ID = "teacher-001";

const CLASS_11_PRE_ENG_ID = "class-11-preeng";
const CLASS_12_PRE_MED_ID = "class-12-premed";
const CLASS_10_GENERAL_ID = "class-10-general";

// wholeGrade-related constants
const MATH_SUBJECT_ID = "subject-math-001";
const CLASS_9_BIO_BOYS_ID = "class-9-bio-boys";
const CLASS_9_CS_BOYS_ID = "class-9-cs-boys";
const CLASS_9_NEW_GROUP_ID = "class-9-new-group";  // created after wholeGrade entry

const APPLIES_TO = [
  { classLevel: CLASS_11_PRE_ENG_ID, required: true },
  { classLevel: CLASS_12_PRE_MED_ID, required: true },
];

// Math with wholeGrade entries (migrated from old format)
const MATH_APPLIES_TO_WHOLE_GRADE = [
  { gradeLevel: "9", required: true },
  { gradeLevel: "10", required: true },
];

// Mixed: one specific + one wholeGrade
const MIXED_APPLIES_TO = [
  { classLevel: CLASS_11_PRE_ENG_ID, required: true },
  { gradeLevel: "9", required: true },
];

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

function makeSubjectDoc(overrides = {}) {
  return {
    _id: SUBJECT_ID,
    name: "Physics",
    description: "Multi-class subject",
    appliesTo: APPLIES_TO.map((a) => ({ ...a })),
    createdBy: ADMIN_ID,
    ...overrides,
  };
}

function makeMathSubjectDoc(overrides = {}) {
  return {
    _id: MATH_SUBJECT_ID,
    name: "Math",
    description: "Whole grade subject",
    appliesTo: MATH_APPLIES_TO_WHOLE_GRADE.map((a) => ({ ...a })),
    createdBy: ADMIN_ID,
    ...overrides,
  };
}

function makeMixedSubjectDoc(overrides = {}) {
  return {
    _id: "subject-mixed-001",
    name: "Mixed Subject",
    description: "Specific + wholeGrade",
    appliesTo: MIXED_APPLIES_TO.map((a) => ({ ...a })),
    createdBy: ADMIN_ID,
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  // Default: ClassLevel.find returns items matching the query's $in array
  const allClasses = [
    { _id: CLASS_11_PRE_ENG_ID },
    { _id: CLASS_12_PRE_MED_ID },
    { _id: CLASS_10_GENERAL_ID },
  ];
  mockClassLevelFind.mockImplementation((query) => {
    if (query && query._id && query._id.$in) {
      const ids = query._id.$in.map(String);
      return Promise.resolve(allClasses.filter((c) => ids.includes(String(c._id))));
    }
    return Promise.resolve(allClasses);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 1: Both appliesTo entries save correctly on creation (specific type)
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 1 – Subject creation with multiple specific appliesTo entries", () => {
  test("PASS: both classLevel refs are persisted", async () => {
    mockSubjectFindOne.mockResolvedValue(null);
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_ID, name: "Intermediate" });
    mockSubjectCreate.mockImplementation(async (doc) => ({
      _id: SUBJECT_ID,
      ...doc,
    }));
    mockProgramFindByIdAndUpdate.mockResolvedValue({});
    const res = makeMockRes();

    await createSubjectService(
      { name: "Physics", description: "Multi-class subject", appliesTo: APPLIES_TO },
      PROGRAM_ID,
      ADMIN_ID,
      res
    );

    expect(mockSubjectCreate).toHaveBeenCalledTimes(1);
    const created = mockSubjectCreate.mock.calls[0][0];
    expect(created.appliesTo).toHaveLength(2);
    expect(created.appliesTo[0]).toEqual({
      classLevel: CLASS_11_PRE_ENG_ID,
      required: true,
    });
    expect(created.appliesTo[1]).toEqual({
      classLevel: CLASS_12_PRE_MED_ID,
      required: true,
    });
    expect(res._statusCode).toBe(200);
    expect(res._body.status).toBe("success");
    expect(res._body.data.appliesTo).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 1b: Subject creation with wholeGrade appliesTo entries
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 1b – Subject creation with wholeGrade appliesTo entries", () => {
  test("PASS: wholeGrade entries are persisted without classLevel validation", async () => {
    mockSubjectFindOne.mockResolvedValue(null);
    mockProgramFindById.mockResolvedValue({ _id: PROGRAM_ID, name: "Secondary" });
    mockSubjectCreate.mockImplementation(async (doc) => ({
      _id: MATH_SUBJECT_ID,
      ...doc,
    }));
    mockProgramFindByIdAndUpdate.mockResolvedValue({});
    const res = makeMockRes();

    await createSubjectService(
      { name: "Math", description: "Whole grade", appliesTo: MATH_APPLIES_TO_WHOLE_GRADE },
      PROGRAM_ID,
      ADMIN_ID,
      res
    );

    expect(mockSubjectCreate).toHaveBeenCalledTimes(1);
    const created = mockSubjectCreate.mock.calls[0][0];
    expect(created.appliesTo).toHaveLength(2);
    expect(created.appliesTo[0]).toEqual({ gradeLevel: "9", required: true });
    expect(created.appliesTo[1]).toEqual({ gradeLevel: "10", required: true });
    expect(res._statusCode).toBe(200);
    expect(res._body.status).toBe("success");
    // ClassLevel.find should NOT have been called for validation since these are wholeGrade
    // (only specific entries trigger classLevel existence check)
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 2: Both entries show up when editing the subject
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 2 – Subject retrieval for editing shows all appliesTo entries", () => {
  test("PASS: getSubjectsService returns both appliesTo entries", async () => {
    const subjectDoc = makeSubjectDoc();
    mockSubjectFindById.mockResolvedValue(subjectDoc);

    const result = await getSubjectsService(SUBJECT_ID);

    expect(result).not.toBeNull();
    expect(result.appliesTo).toHaveLength(2);
    expect(result.appliesTo[0].classLevel).toBe(CLASS_11_PRE_ENG_ID);
    expect(result.appliesTo[1].classLevel).toBe(CLASS_12_PRE_MED_ID);
  });

  test("PASS: getAllSubjectsService includes the subject with both entries", async () => {
    const subjectDoc = makeSubjectDoc();
    mockSubjectFind.mockResolvedValue([subjectDoc]);

    const result = await getAllSubjectsService();

    expect(result).toHaveLength(1);
    expect(result[0].appliesTo).toHaveLength(2);
    const refs = result[0].appliesTo.map((a) => a.classLevel);
    expect(refs).toContain(CLASS_11_PRE_ENG_ID);
    expect(refs).toContain(CLASS_12_PRE_MED_ID);
  });

  test("PASS: updateSubjectService persists modified appliesTo correctly", async () => {
    const updatedAppliesTo = [
      { classLevel: CLASS_11_PRE_ENG_ID, required: true },
      { classLevel: CLASS_12_PRE_MED_ID, required: false },
      { classLevel: CLASS_10_GENERAL_ID, required: true },
    ];

    mockSubjectFindOne.mockResolvedValue(null);

    const updatedDoc = makeSubjectDoc({ appliesTo: updatedAppliesTo });
    const mongooseFindByIdAndUpdate = jest.fn().mockResolvedValue(updatedDoc);

    const Subject = require("../models/Academic/subject.model");
    Subject.findByIdAndUpdate = mongooseFindByIdAndUpdate;

    const res = makeMockRes();
    const result = await updateSubjectService(
      { name: "Physics", description: "Updated", appliesTo: updatedAppliesTo },
      SUBJECT_ID,
      ADMIN_ID,
      res
    );

    expect(mongooseFindByIdAndUpdate).toHaveBeenCalledTimes(1);
    const updateArg = mongooseFindByIdAndUpdate.mock.calls[0][1];
    expect(updateArg.appliesTo).toHaveLength(3);
    expect(updateArg.appliesTo[2].classLevel).toBe(CLASS_10_GENERAL_ID);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 3: Assignment creation for matching specific classLevels
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 3 – Assignment creation for matching specific classLevels", () => {
  test("PASS: Assignment succeeds for Class 11 Pre-Engineering", async () => {
    const subjectDoc = makeSubjectDoc();
    mockSubjectFindById.mockResolvedValue(subjectDoc);

    mockClassLevelFindById.mockResolvedValue({
      _id: CLASS_11_PRE_ENG_ID,
      name: "Class 11 Pre-Engineering",
      gradeLevel: "11",
      group: "Pre-Engineering",
      section: "Boys",
    });

    mockAssignmentFindOne.mockResolvedValue(null);
    mockAssignmentCreate.mockImplementation(async (doc) => ({
      _id: "assignment-001",
      ...doc,
    }));

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: SUBJECT_ID, classLevel: CLASS_11_PRE_ENG_ID },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test("PASS: Assignment succeeds for Class 12 Pre-Medical", async () => {
    const subjectDoc = makeSubjectDoc();
    mockSubjectFindById.mockResolvedValue(subjectDoc);

    mockClassLevelFindById.mockResolvedValue({
      _id: CLASS_12_PRE_MED_ID,
      name: "Class 12 Pre-Medical",
      gradeLevel: "12",
      group: "Pre-Medical",
      section: "Girls",
    });

    mockAssignmentFindOne.mockResolvedValue(null);
    mockAssignmentCreate.mockImplementation(async (doc) => ({
      _id: "assignment-002",
      ...doc,
    }));

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: SUBJECT_ID, classLevel: CLASS_12_PRE_MED_ID },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 4: Assignment creation for NON-matching classLevel (should FAIL)
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 4 – Assignment creation for non-matching classLevel (should NOT succeed)", () => {
  test("PASS: Assignment FAILS for Class 10 (not in appliesTo)", async () => {
    const subjectDoc = makeSubjectDoc();
    mockSubjectFindById.mockResolvedValue(subjectDoc);

    mockClassLevelFindById.mockResolvedValue({
      _id: CLASS_10_GENERAL_ID,
      name: "Class 10 General",
      gradeLevel: "10",
      group: null,
      section: null,
    });

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: SUBJECT_ID, classLevel: CLASS_10_GENERAL_ID },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(400);
    expect(res._body.status).toBe("failed");
    expect(res._body.message).toMatch(/not taught in/i);
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });

  test("PASS: specific entry does NOT match a different ClassLevel with same gradeLevel", async () => {
    // Physics has specific entry for CLASS_11_PRE_ENG_ID (grade 11, Pre-Engineering).
    // Class 11 Pre-Medical is also grade 11 but a different ClassLevel ID.
    // The specific entry should NOT match it.
    const subjectDoc = makeSubjectDoc();
    mockSubjectFindById.mockResolvedValue(subjectDoc);

    mockClassLevelFindById.mockResolvedValue({
      _id: "class-11-premed",
      name: "Class 11 Pre-Medical",
      gradeLevel: "11",
      group: "Pre-Medical",
      section: null,
    });

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: SUBJECT_ID, classLevel: "class-11-premed" },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(400);
    expect(res._body.status).toBe("failed");
    expect(res._body.message).toMatch(/not taught in/i);
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 5: wholeGrade matching — Math grade 9 matches ALL grade-9 classes
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 5 – wholeGrade Math entry matches any grade-9 class regardless of group", () => {
  beforeEach(() => {
    const mathDoc = makeMathSubjectDoc();
    mockSubjectFindById.mockResolvedValue(mathDoc);

    mockClassLevelFindById.mockImplementation(async (id) => {
      const classes = {
        [CLASS_9_BIO_BOYS_ID]: {
          _id: CLASS_9_BIO_BOYS_ID,
          name: "9th Biology Boys",
          gradeLevel: "9",
          group: "Biology",
          section: "Boys",
        },
        [CLASS_9_CS_BOYS_ID]: {
          _id: CLASS_9_CS_BOYS_ID,
          name: "9th Computer Science Boys",
          gradeLevel: "9",
          group: "Computer Science",
          section: "Boys",
        },
        [CLASS_9_NEW_GROUP_ID]: {
          _id: CLASS_9_NEW_GROUP_ID,
          name: "9th Arts Girls",
          gradeLevel: "9",
          group: "Arts",
          section: "Girls",
        },
      };
      return classes[id] || null;
    });
  });

  test("PASS: wholeGrade Math matches 9th Biology Boys", async () => {
    mockAssignmentFindOne.mockResolvedValue(null);
    mockAssignmentCreate.mockImplementation(async (doc) => ({
      _id: "assign-math-bio",
      ...doc,
    }));

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: MATH_SUBJECT_ID, classLevel: CLASS_9_BIO_BOYS_ID },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test("PASS: wholeGrade Math matches 9th Computer Science Boys", async () => {
    mockAssignmentFindOne.mockResolvedValue(null);
    mockAssignmentCreate.mockImplementation(async (doc) => ({
      _id: "assign-math-cs",
      ...doc,
    }));

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: MATH_SUBJECT_ID, classLevel: CLASS_9_CS_BOYS_ID },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test("PASS: wholeGrade Math matches a NEW grade-9 class created after the subject (9th Arts Girls)", async () => {
    // This simulates a ClassLevel created AFTER the wholeGrade entry existed.
    // The wholeGrade entry should still match it because it matches by gradeLevel.
    mockAssignmentFindOne.mockResolvedValue(null);
    mockAssignmentCreate.mockImplementation(async (doc) => ({
      _id: "assign-math-arts",
      ...doc,
    }));

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: MATH_SUBJECT_ID, classLevel: CLASS_9_NEW_GROUP_ID },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
    expect(mockAssignmentCreate).toHaveBeenCalledTimes(1);
  });

  test("PASS: wholeGrade Math FAILS for grade-10 class when only grade 9 and 10 are in appliesTo, but testing grade-8", async () => {
    // Grade 8 is NOT in Math's appliesTo (which has grades 9 and 10)
    mockClassLevelFindById.mockResolvedValue({
      _id: "class-8-general",
      name: "Class 8 General",
      gradeLevel: "8",
      group: null,
      section: null,
    });

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: MATH_SUBJECT_ID, classLevel: "class-8-general" },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(400);
    expect(res._body.status).toBe("failed");
    expect(res._body.message).toMatch(/not taught in/i);
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 5b: wholeGrade Test creation matches any grade-9 class
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 5b – wholeGrade Test creation matches any class in the grade", () => {
  beforeEach(() => {
    const mathDoc = makeMathSubjectDoc();
    mockSubjectFindById.mockResolvedValue(mathDoc);

    mockClassLevelFindById.mockImplementation(async (id) => {
      const classes = {
        [CLASS_9_BIO_BOYS_ID]: {
          _id: CLASS_9_BIO_BOYS_ID,
          name: "9th Biology Boys",
          gradeLevel: "9",
          group: "Biology",
          section: "Boys",
        },
        [CLASS_9_CS_BOYS_ID]: {
          _id: CLASS_9_CS_BOYS_ID,
          name: "9th Computer Science Boys",
          gradeLevel: "9",
          group: "Computer Science",
          section: "Boys",
        },
        [CLASS_9_NEW_GROUP_ID]: {
          _id: CLASS_9_NEW_GROUP_ID,
          name: "9th Arts Girls",
          gradeLevel: "9",
          group: "Arts",
          section: "Girls",
        },
      };
      return classes[id] || null;
    });
  });

  test("PASS: Test creation succeeds for 9th Biology Boys with wholeGrade Math", async () => {
    mockTestCreate.mockImplementation(async (doc) => ({
      _id: "test-math-bio",
      ...doc,
    }));

    const res = makeMockRes();
    await createTestService(
      {
        name: "Math Quiz Bio",
        subject: MATH_SUBJECT_ID,
        classLevels: [CLASS_9_BIO_BOYS_ID],
        date: new Date("2026-03-15"),
        totalMarks: 100,
        passMarks: 40,
      },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
    expect(mockTestCreate).toHaveBeenCalledTimes(1);
  });

  test("PASS: Test creation succeeds for 9th Computer Science Boys with wholeGrade Math", async () => {
    mockTestCreate.mockImplementation(async (doc) => ({
      _id: "test-math-cs",
      ...doc,
    }));

    const res = makeMockRes();
    await createTestService(
      {
        name: "Math Quiz CS",
        subject: MATH_SUBJECT_ID,
        classLevels: [CLASS_9_CS_BOYS_ID],
        date: new Date("2026-03-16"),
        totalMarks: 100,
        passMarks: 40,
      },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
    expect(mockTestCreate).toHaveBeenCalledTimes(1);
  });

  test("PASS: Test creation succeeds for BOTH grade-9 classes simultaneously", async () => {
    mockTestCreate.mockImplementation(async (doc) => ({
      _id: "test-math-combined",
      ...doc,
    }));

    const res = makeMockRes();
    await createTestService(
      {
        name: "Math Grade 9 Combined",
        subject: MATH_SUBJECT_ID,
        classLevels: [CLASS_9_BIO_BOYS_ID, CLASS_9_CS_BOYS_ID],
        date: new Date("2026-04-01"),
        totalMarks: 100,
        passMarks: 40,
      },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
    const created = mockTestCreate.mock.calls[0][0];
    expect(created.classLevels).toHaveLength(2);
  });

  test("PASS: Test creation for NEW grade-9 class (created after wholeGrade entry) succeeds", async () => {
    mockTestCreate.mockImplementation(async (doc) => ({
      _id: "test-math-new",
      ...doc,
    }));

    const res = makeMockRes();
    await createTestService(
      {
        name: "Math Quiz Arts",
        subject: MATH_SUBJECT_ID,
        classLevels: [CLASS_9_NEW_GROUP_ID],
        date: new Date("2026-05-01"),
        totalMarks: 100,
        passMarks: 40,
      },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
    expect(mockTestCreate).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 6: Mixed specific + wholeGrade — both types work together
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 6 – Mixed specific + wholeGrade subject", () => {
  beforeEach(() => {
    const mixedDoc = makeMixedSubjectDoc();
    mockSubjectFindById.mockResolvedValue(mixedDoc);

    mockClassLevelFindById.mockImplementation(async (id) => {
      const classes = {
        [CLASS_11_PRE_ENG_ID]: {
          _id: CLASS_11_PRE_ENG_ID,
          name: "Class 11 Pre-Engineering",
          gradeLevel: "11",
          group: "Pre-Engineering",
          section: "Boys",
        },
        [CLASS_9_BIO_BOYS_ID]: {
          _id: CLASS_9_BIO_BOYS_ID,
          name: "9th Biology Boys",
          gradeLevel: "9",
          group: "Biology",
          section: "Boys",
        },
        [CLASS_9_CS_BOYS_ID]: {
          _id: CLASS_9_CS_BOYS_ID,
          name: "9th Computer Science Boys",
          gradeLevel: "9",
          group: "Computer Science",
          section: "Boys",
        },
        "class-11-premed": {
          _id: "class-11-premed",
          name: "Class 11 Pre-Medical",
          gradeLevel: "11",
          group: "Pre-Medical",
          section: null,
        },
      };
      return classes[id] || null;
    });
  });

  test("PASS: specific entry matches exact ClassLevel (11 Pre-Engineering)", async () => {
    mockAssignmentFindOne.mockResolvedValue(null);
    mockAssignmentCreate.mockImplementation(async (doc) => ({ ...doc, _id: "a1" }));

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: "subject-mixed-001", classLevel: CLASS_11_PRE_ENG_ID },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
  });

  test("PASS: wholeGrade entry matches grade-9 class (9th Biology Boys)", async () => {
    mockAssignmentFindOne.mockResolvedValue(null);
    mockAssignmentCreate.mockImplementation(async (doc) => ({ ...doc, _id: "a2" }));

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: "subject-mixed-001", classLevel: CLASS_9_BIO_BOYS_ID },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
  });

  test("PASS: wholeGrade entry matches another grade-9 class (9th CS Boys)", async () => {
    mockAssignmentFindOne.mockResolvedValue(null);
    mockAssignmentCreate.mockImplementation(async (doc) => ({ ...doc, _id: "a3" }));

    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: "subject-mixed-001", classLevel: CLASS_9_CS_BOYS_ID },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
  });

  test("FAIL: specific entry does NOT match different class with same grade (11 Pre-Medical)", async () => {
    // The subject has specific for 11 Pre-Engineering only, not 11 Pre-Medical.
    // The wholeGrade entry is for grade 9, not grade 11.
    // So 11 Pre-Medical should NOT match.
    const res = makeMockRes();
    await createAssignmentService(
      { teacher: TEACHER_ID, subject: "subject-mixed-001", classLevel: "class-11-premed" },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(400);
    expect(res._body.status).toBe("failed");
    expect(mockAssignmentCreate).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 7: Test creation appliesTo validation — must reject mismatched classLevels
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 7 – Test creation appliesTo validation (specific entries)", () => {
  beforeEach(() => {
    const subjectDoc = makeSubjectDoc();
    mockSubjectFindById.mockResolvedValue(subjectDoc);

    mockClassLevelFindById.mockImplementation(async (id) => {
      const classes = {
        [CLASS_11_PRE_ENG_ID]: {
          _id: CLASS_11_PRE_ENG_ID,
          name: "Class 11 Pre-Engineering",
          gradeLevel: "11",
          group: "Pre-Engineering",
          section: "Boys",
        },
        [CLASS_12_PRE_MED_ID]: {
          _id: CLASS_12_PRE_MED_ID,
          name: "Class 12 Pre-Medical",
          gradeLevel: "12",
          group: "Pre-Medical",
          section: "Girls",
        },
        [CLASS_10_GENERAL_ID]: {
          _id: CLASS_10_GENERAL_ID,
          name: "Class 10 General",
          gradeLevel: "10",
          group: null,
          section: null,
        },
        "class-11-premed": {
          _id: "class-11-premed",
          name: "Class 11 Pre-Medical",
          gradeLevel: "11",
          group: "Pre-Medical",
          section: null,
        },
      };
      return classes[id] || null;
    });
  });

  test("PASS: Test creation succeeds for Class 11 Pre-Engineering", async () => {
    mockTestCreate.mockImplementation(async (doc) => ({ _id: "test-001", ...doc }));

    const res = makeMockRes();
    await createTestService(
      {
        name: "Physics Mid-Term",
        subject: SUBJECT_ID,
        classLevels: [CLASS_11_PRE_ENG_ID],
        date: new Date("2026-03-15"),
        totalMarks: 100,
        passMarks: 40,
      },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(201);
    expect(res._body.status).toBe("success");
  });

  test("PASS: Test creation FAILS when one classLevel doesn't match", async () => {
    const res = makeMockRes();
    await createTestService(
      {
        name: "Physics Bad Test",
        subject: SUBJECT_ID,
        classLevels: [CLASS_11_PRE_ENG_ID, CLASS_10_GENERAL_ID],
        date: new Date("2026-05-01"),
        totalMarks: 100,
        passMarks: 40,
      },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(400);
    expect(res._body.status).toBe("failed");
    expect(res._body.message).toMatch(/not taught in/i);
    expect(mockTestCreate).not.toHaveBeenCalled();
  });

  test("PASS: Test creation FAILS for specific entry mismatch (11 Pre-Medical not in appliesTo)", async () => {
    const res = makeMockRes();
    await createTestService(
      {
        name: "Physics Wrong Class",
        subject: SUBJECT_ID,
        classLevels: ["class-11-premed"],
        date: new Date("2026-05-01"),
        totalMarks: 100,
        passMarks: 40,
      },
      ADMIN_ID,
      res
    );

    expect(res._statusCode).toBe(400);
    expect(res._body.status).toBe("failed");
    expect(res._body.message).toMatch(/not taught in/i);
    expect(mockTestCreate).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST 8: Subject visibility in dropdown
// ═════════════════════════════════════════════════════════════════════════════
describe("Test 8 – Subject visibility in dropdown (getAllSubjectsService)", () => {
  test("PASS: Subject is returned by getAllSubjectsService", async () => {
    const subjectDoc = makeSubjectDoc();
    mockSubjectFind.mockResolvedValue([subjectDoc]);

    const subjects = await getAllSubjectsService();

    expect(subjects).toHaveLength(1);
    expect(subjects[0]._id).toBe(SUBJECT_ID);
    expect(subjects[0].name).toBe("Physics");
    expect(subjects[0].appliesTo).toHaveLength(2);
  });

  test("PASS: wholeGrade subject is returned by getAllSubjectsService", async () => {
    const mathDoc = makeMathSubjectDoc();
    mockSubjectFind.mockResolvedValue([mathDoc]);

    const subjects = await getAllSubjectsService();

    expect(subjects).toHaveLength(1);
    expect(subjects[0].name).toBe("Math");
    expect(subjects[0].appliesTo).toHaveLength(2);
    expect(subjects[0].appliesTo[0].gradeLevel).toBe("9");
    expect(subjects[0].appliesTo[1].gradeLevel).toBe("10");
  });
});
