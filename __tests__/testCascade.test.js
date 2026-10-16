/**
 * Tests for the redesigned teacher marking cascade API:
 *   Session → Grade → Section → Phase → Week → Subject → Test
 *   - GET /tests/cascade/sessions            (no upstream selection needed)
 *   - GET /tests/cascade/grades?session=
 *   - GET /tests/cascade/sections?session=&grade=
 *   - GET /tests/cascade/phases?session=&section=
 *   - GET /tests/cascade/weeks?session=&section=&phase=
 *   - GET /tests/cascade/subjects?session=&section=[&phase=&week=]
 *   - GET /tests/cascade/tests?classLevel=&subject=[&session=&phase=&week=]
 *
 * Verifies that:
 *   • Every level is derived ONLY from the teacher's own Assignment records.
 *   • Pair-wise scoping: a Test query pins (subject, classLevel) together in
 *     one $or clause — a subject the teacher holds only in another section
 *     can never leak data for this section ("9th Boys vs 9th Girls").
 *   • Crafted ids are filters, never grants: unassigned section/grade → 403,
 *     foreign session → empty, and no Test read happens past a failed guard.
 *   • /cascade/tests is lean with the sort in the query (no hydration).
 *   • Legacy /cascade/classes (empty-state) behavior is unchanged.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAssignmentFind = jest.fn();
const mockAssignmentFindOne = jest.fn();
const mockAssignmentDistinct = jest.fn();
const mockClassLevelFind = jest.fn();
const mockSubjectFind = jest.fn();
const mockTestFind = jest.fn();
const mockTestDistinct = jest.fn();
const mockTestCountDocuments = jest.fn();
const mockTestSessionFind = jest.fn();
const mockTestSessionFindById = jest.fn();
const mockWeekFind = jest.fn();

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
}));

jest.mock("../models/Academic/test.model", () => ({
  find: mockTestFind,
  distinct: mockTestDistinct,
  countDocuments: mockTestCountDocuments,
}));

jest.mock("../models/Academic/testSession.model", () => ({
  find: mockTestSessionFind,
  findById: mockTestSessionFindById,
}));

jest.mock("../models/Academic/week.model", () => ({
  find: mockWeekFind,
}));

// Mock responseStatus to capture calls
const mockResponseStatus = jest.fn((res, status, statusText, data) => {
  res.status(status).json({ status: statusText, data, message: data });
});

jest.mock("../handlers/responseStatus.handler", () => mockResponseStatus);

const {
  getTeacherAssignedClassesService,
  getTeacherCascadeSessionsService,
  getTeacherCascadeGradesService,
  getTeacherCascadeSectionsService,
  getTeacherCascadePhasesService,
  getTeacherCascadeWeeksService,
  getTeacherCascadeSubjectsService,
  getTeacherScopedTestsByClassSubjectService,
} = require("../services/academic/test.service");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Chainable lean() query stub. Real Mongoose queries chain in any order. */
const leanQuery = (docs) => {
  const q = {
    select: jest.fn(() => q),
    populate: jest.fn(() => q),
    sort: jest.fn(() => q),
    lean: jest.fn(async () => docs),
  };
  return q;
};

/** Stub for the legacy classes service: find().distinct() resolves directly. */
const distinctStub = (docs) => ({ distinct: jest.fn().mockResolvedValue(docs) });

// ── Test Data ────────────────────────────────────────────────────────────────

const TEACHER_A = "teacher-a-id";
const CLASS_9_BOYS = "class-9-bio-boys";
const CLASS_9_GIRLS = "class-9-bio-girls";   // same grade, NOT assigned
const CLASS_11_ENGINEERING = "class-11-eng"; // assigned, different grade
const SUBJECT_MATH = "sub-math";
const SUBJECT_SCIENCE = "sub-science";
const SUBJECT_URDU = "sub-urdu";             // exists but NOT assigned
const SESSION_1 = "session-midterm";
const PHASE_1 = "phase-1";
const PHASE_2 = "phase-2";
const WEEK_1 = "week-1";

// Teacher A: Math + Science in 9th Boys, Math in 11th Engineering.
const PAIRS_A = [
  { subject: SUBJECT_MATH, classLevel: CLASS_9_BOYS },
  { subject: SUBJECT_SCIENCE, classLevel: CLASS_9_BOYS },
  { subject: SUBJECT_MATH, classLevel: CLASS_11_ENGINEERING },
];

const mockPairs = (pairs = PAIRS_A) => mockAssignmentFind.mockReturnValue(leanQuery(pairs));

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Legacy Level: getTeacherAssignedClassesService (page empty-state) ────────

describe("Legacy: getTeacherAssignedClassesService", () => {
  test("returns only classes the teacher is assigned to", async () => {
    mockAssignmentFind.mockReturnValue(distinctStub([CLASS_9_BOYS, CLASS_11_ENGINEERING]));
    const expectedClasses = [
      { _id: CLASS_9_BOYS, name: "9th Biology Boys", gradeLevel: "9", group: "Biology" },
      { _id: CLASS_11_ENGINEERING, name: "11th Engineering", gradeLevel: "11", group: "Pre-Engineering" },
    ];
    mockClassLevelFind.mockReturnValue({
      select: jest.fn().mockReturnValue({ sort: jest.fn().mockResolvedValue(expectedClasses) }),
    });

    const res = mockRes();
    await getTeacherAssignedClassesService(TEACHER_A, res);

    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(2);
  });

  test("returns empty array when teacher has no assignments", async () => {
    mockAssignmentFind.mockReturnValue(distinctStub([]));
    const res = mockRes();
    await getTeacherAssignedClassesService(TEACHER_A, res);
    expect(res.json.mock.calls[0][0].data).toHaveLength(0);
  });
});

// ── Level 1: sessions ────────────────────────────────────────────────────────

describe("Cascade Level 1: getTeacherCascadeSessionsService", () => {
  test("derives sessions from ALL assigned tests — pair-wise, no client filters", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([SESSION_1]);
    mockTestCountDocuments.mockResolvedValue(0);
    mockTestSessionFind.mockReturnValue(leanQuery([{ _id: SESSION_1, name: "Midterm" }]));

    const res = mockRes();
    await getTeacherCascadeSessionsService(TEACHER_A, res);

    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data.sessions).toHaveLength(1);
    expect(response.data.hasUnassigned).toBe(false);
    // Clause-level pair pinning is asserted in the dedicated SECURITY test.
    expect(mockTestDistinct.mock.calls[0][1].$or).toHaveLength(3);
  });

  test("SECURITY: query clauses each pin subject AND classLevel together", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([]);
    mockTestCountDocuments.mockResolvedValue(0);

    await getTeacherCascadeSessionsService(TEACHER_A, mockRes());
    const filter = mockTestDistinct.mock.calls[0][1];
    expect(filter.$or).toEqual([
      { subject: SUBJECT_MATH, classLevels: CLASS_9_BOYS },
      { subject: SUBJECT_SCIENCE, classLevels: CLASS_9_BOYS },
      { subject: SUBJECT_MATH, classLevels: CLASS_11_ENGINEERING },
    ]);
  });

  test("teacher with no assignments gets nothing and no Test read happens", async () => {
    mockPairs([]);
    const res = mockRes();
    await getTeacherCascadeSessionsService(TEACHER_A, res);

    expect(res.json.mock.calls[0][0].data).toEqual({ sessions: [], hasUnassigned: false });
    expect(mockTestDistinct).not.toHaveBeenCalled();
  });

  test("surfaces the no-session bucket as hasUnassigned", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([]);
    mockTestCountDocuments.mockResolvedValue(2);

    const res = mockRes();
    await getTeacherCascadeSessionsService(TEACHER_A, res);
    expect(res.json.mock.calls[0][0].data.hasUnassigned).toBe(true);
  });
});

// ── Level 2: grades ──────────────────────────────────────────────────────────

describe("Cascade Level 2: getTeacherCascadeGradesService", () => {
  test("returns 400 when session is missing", async () => {
    const res = mockRes();
    await getTeacherCascadeGradesService(TEACHER_A, null, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("returns only grades of the teacher's assigned classes that have a test in the session", async () => {
    mockPairs();
    // School-wide ClassLevel rows must NOT widen this: the intersect keys off
    // the teacher's own class ids only.
    mockTestDistinct.mockResolvedValue([CLASS_9_BOYS]);
    mockClassLevelFind.mockReturnValue(leanQuery([
      { _id: CLASS_9_BOYS, gradeLevel: "9" },
      { _id: CLASS_11_ENGINEERING, gradeLevel: "11" },
    ]));

    const res = mockRes();
    await getTeacherCascadeGradesService(TEACHER_A, SESSION_1, res);

    const response = res.json.mock.calls[0][0];
    expect(response.data.grades).toEqual(["9"]); // 11 has no test this session
    // The Test read is pair-scoped AND narrowed by the chosen session.
    const filter = mockTestDistinct.mock.calls[0][1];
    expect(filter.$or).toBeDefined();
    expect(filter.session).toBe(SESSION_1);
  });

  test("session=none maps to the no-session bucket", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([CLASS_9_BOYS]);
    mockClassLevelFind.mockReturnValue(leanQuery([{ _id: CLASS_9_BOYS, gradeLevel: "9" }]));

    await getTeacherCascadeGradesService(TEACHER_A, "none", mockRes());
    expect(mockTestDistinct.mock.calls[0][1].session).toBe(null);
  });

  test("SECURITY: a foreign session id yields an empty grade list, never data", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([]); // nothing matches the foreign id
    mockClassLevelFind.mockReturnValue(leanQuery([{ _id: CLASS_9_BOYS, gradeLevel: "9" }]));

    const res = mockRes();
    await getTeacherCascadeGradesService(TEACHER_A, "some-other-teachers-session", res);
    expect(res.json.mock.calls[0][0].data.grades).toEqual([]);
  });

  test("grades come back in school order (PG before 9 before 11)", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([CLASS_11_ENGINEERING, CLASS_9_BOYS]);
    mockClassLevelFind.mockReturnValue(leanQuery([
      { _id: CLASS_11_ENGINEERING, gradeLevel: "11" },
      { _id: CLASS_9_BOYS, gradeLevel: "9" },
    ]));

    const res = mockRes();
    await getTeacherCascadeGradesService(TEACHER_A, SESSION_1, res);
    expect(res.json.mock.calls[0][0].data.grades).toEqual(["9", "11"]);
  });
});

// ── Level 3: sections ────────────────────────────────────────────────────────

describe("Cascade Level 3: getTeacherCascadeSectionsService", () => {
  const CLASS_DOCS = [
    { _id: CLASS_9_BOYS, name: "9th Biology Boys", gradeLevel: "9", group: "Biology", section: "Boys" },
    { _id: CLASS_9_GIRLS, name: "9th Biology Girls", gradeLevel: "9", section: "Girls" },
    { _id: CLASS_11_ENGINEERING, name: "11th Engineering", gradeLevel: "11", group: "Pre-Engineering" },
  ];

  test("returns 400 when session or grade is missing", async () => {
    const res = mockRes();
    await getTeacherCascadeSectionsService(TEACHER_A, SESSION_1, null, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("lists only the teacher's assigned sections with a test in the session", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([CLASS_9_BOYS]);
    mockClassLevelFind.mockReturnValue(leanQuery(CLASS_DOCS));

    const res = mockRes();
    await getTeacherCascadeSectionsService(TEACHER_A, SESSION_1, "9", res);

    const sections = res.json.mock.calls[0][0].data.sections;
    expect(sections).toHaveLength(1);
    expect(sections[0]._id).toBe(CLASS_9_BOYS);
    // SECURITY: 9th Girls exists in the SAME grade and the ClassLevel table
    // contains it — it still never appears because it is not an assignment.
    expect(sections.some((s) => s._id === CLASS_9_GIRLS)).toBe(false);
  });

  test("SECURITY: a grade the teacher is not assigned to is rejected with 403", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([]);
    mockClassLevelFind.mockReturnValue(leanQuery(CLASS_DOCS));

    const res = mockRes();
    await getTeacherCascadeSectionsService(TEACHER_A, SESSION_1, "12", res);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ── Level 4: phases ──────────────────────────────────────────────────────────

describe("Cascade Level 4: getTeacherCascadePhasesService", () => {
  test("SECURITY: an unassigned section is rejected with 403 before any Test read", async () => {
    mockPairs();
    const res = mockRes();
    await getTeacherCascadePhasesService(TEACHER_A, SESSION_1, CLASS_9_GIRLS, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockTestDistinct).not.toHaveBeenCalled();
    expect(mockTestCountDocuments).not.toHaveBeenCalled();
  });

  test("SECURITY: rejects malformed section ids with 403", async () => {
    mockPairs();
    const res = mockRes();
    await getTeacherCascadePhasesService(TEACHER_A, SESSION_1, "<script>", res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("accepts a comma-separated section list (\"All sections\") and unions the pairs", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([PHASE_1]);
    mockTestCountDocuments.mockResolvedValue(0);
    mockTestSessionFindById.mockReturnValue(
      leanQuery({ _id: SESSION_1, phases: [{ _id: PHASE_1, name: "Phase 1", order: 1 }] })
    );

    const res = mockRes();
    await getTeacherCascadePhasesService(TEACHER_A, SESSION_1, `${CLASS_9_BOYS},${CLASS_11_ENGINEERING}`, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.phases).toHaveLength(1);
    // Every listed section contributes its own (subject, classLevel) clauses.
    const classes = new Set(mockTestDistinct.mock.calls[0][1].$or.map((c) => String(c.classLevels)));
    expect(classes).toEqual(new Set([CLASS_9_BOYS, CLASS_11_ENGINEERING]));
  });

  test("SECURITY: a section list containing ANY unassigned id is rejected with 403", async () => {
    mockPairs();
    const res = mockRes();
    await getTeacherCascadePhasesService(TEACHER_A, SESSION_1, `${CLASS_9_BOYS},${CLASS_9_GIRLS}`, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockTestDistinct).not.toHaveBeenCalled();
  });

  test("returns session phases that actually have a test, in defined order", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([PHASE_2]);
    mockTestCountDocuments.mockResolvedValue(0);
    mockTestSessionFindById.mockReturnValue(
      leanQuery({ _id: SESSION_1, phases: [
        { _id: PHASE_1, name: "Phase 1", order: 1 },
        { _id: PHASE_2, name: "Phase 2", order: 2 },
      ] })
    );

    const res = mockRes();
    await getTeacherCascadePhasesService(TEACHER_A, SESSION_1, CLASS_9_BOYS, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.phases).toHaveLength(1);
    expect(data.phases[0].name).toBe("Phase 2");
    // Query pins the section together with each assigned subject.
    const filter = mockTestDistinct.mock.calls[0][1];
    expect(filter.session).toBe(SESSION_1);
    expect(filter.$or.every((c) => String(c.classLevels) === CLASS_9_BOYS)).toBe(true);
    expect(filter.$or.some((c) => String(c.subject) === SUBJECT_URDU)).toBe(false);
  });

  test("SECURITY: session=none has no phases — rejected instead of leaking", async () => {
    mockPairs();
    const res = mockRes();
    await getTeacherCascadePhasesService(TEACHER_A, "none", CLASS_9_BOYS, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ── Level 5: weeks ───────────────────────────────────────────────────────────

describe("Cascade Level 5: getTeacherCascadeWeeksService", () => {
  test("SECURITY: an unassigned section is rejected with 403 before any Test read", async () => {
    mockPairs();
    const res = mockRes();
    await getTeacherCascadeWeeksService(TEACHER_A, SESSION_1, CLASS_9_GIRLS, PHASE_1, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockTestDistinct).not.toHaveBeenCalled();
  });

  test("returns weeks of the session+phase that have a test for this teacher", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([WEEK_1]);
    mockTestCountDocuments.mockResolvedValue(0);
    mockWeekFind.mockReturnValue(leanQuery([
      { _id: WEEK_1, name: "Week 3", startDate: new Date("2026-01-12"), endDate: new Date("2026-01-16") },
    ]));

    const res = mockRes();
    await getTeacherCascadeWeeksService(TEACHER_A, SESSION_1, CLASS_9_BOYS, PHASE_1, res);

    const data = res.json.mock.calls[0][0].data;
    expect(data.weeks).toHaveLength(1);
    const filter = mockTestDistinct.mock.calls[0][1];
    expect(filter.session).toBe(SESSION_1);
    expect(filter.phase).toBe(PHASE_1);
  });

  test("rejects phase=none (no weeks bucket) with 400", async () => {
    mockPairs();
    const res = mockRes();
    await getTeacherCascadeWeeksService(TEACHER_A, SESSION_1, CLASS_9_BOYS, "none", res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ── Level 6: subjects ────────────────────────────────────────────────────────

describe("Cascade Level 6: getTeacherCascadeSubjectsService", () => {
  test("SECURITY: an unassigned section is rejected with 403 before any Test read", async () => {
    mockPairs();
    const res = mockRes();
    await getTeacherCascadeSubjectsService(TEACHER_A, SESSION_1, CLASS_9_GIRLS, null, null, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockTestDistinct).not.toHaveBeenCalled();
  });

  test("section list (\"All sections\") offers subjects from every listed section", async () => {
    mockPairs();
    // Math lives in both listed sections, Science only in 9th Boys; Urdu in none.
    mockTestDistinct.mockResolvedValue([SUBJECT_MATH, SUBJECT_SCIENCE, SUBJECT_URDU]);
    mockSubjectFind.mockReturnValue(leanQuery([
      { _id: SUBJECT_MATH, name: "Mathematics" },
      { _id: SUBJECT_SCIENCE, name: "Science" },
    ]));

    const res = mockRes();
    await getTeacherCascadeSubjectsService(TEACHER_A, SESSION_1, `${CLASS_9_BOYS},${CLASS_11_ENGINEERING}`, null, null, res);

    const scopedIds = mockSubjectFind.mock.calls[0][0]._id.$in.map(String);
    expect(scopedIds).toContain(SUBJECT_MATH);
    expect(scopedIds).toContain(SUBJECT_SCIENCE);
    // The foreign Urdu id never reaches the Subject lookup.
    expect(scopedIds).not.toContain(SUBJECT_URDU);
    // Query spans BOTH sections via the union of pairs.
    const classes = new Set(mockTestDistinct.mock.calls[0][1].$or.map((c) => String(c.classLevels)));
    expect(classes).toEqual(new Set([CLASS_9_BOYS, CLASS_11_ENGINEERING]));
  });

  test("offers only subjects the teacher holds for THIS section", async () => {
    mockPairs();
    // A Math+Urdu test exists in 9th Boys; Urdu is another teacher's subject.
    mockTestDistinct.mockResolvedValue([SUBJECT_MATH, SUBJECT_URDU]);
    mockSubjectFind.mockReturnValue(leanQuery([
      { _id: SUBJECT_MATH, name: "Mathematics", displayName: "Math" },
    ]));

    const res = mockRes();
    await getTeacherCascadeSubjectsService(TEACHER_A, SESSION_1, CLASS_9_BOYS, PHASE_1, WEEK_1, res);

    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    // Intersected with the pair set — the foreign Urdu id never reaches the
    // Subject lookup.
    const scopedIds = mockSubjectFind.mock.calls[0][0]._id.$in.map(String);
    expect(scopedIds).toContain(SUBJECT_MATH);
    expect(scopedIds).not.toContain(SUBJECT_URDU);
  });

  test("propagates phase and week narrowing into the Test query", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([SUBJECT_MATH]);
    mockSubjectFind.mockReturnValue(leanQuery([{ _id: SUBJECT_MATH, name: "Mathematics" }]));

    await getTeacherCascadeSubjectsService(TEACHER_A, SESSION_1, CLASS_9_BOYS, PHASE_1, WEEK_1, mockRes());
    const filter = mockTestDistinct.mock.calls[0][1];
    expect(filter.session).toBe(SESSION_1);
    expect(filter.phase).toBe(PHASE_1);
    expect(filter.week).toBe(WEEK_1);
  });

  test("session=none narrows to tests without a session", async () => {
    mockPairs();
    mockTestDistinct.mockResolvedValue([SUBJECT_MATH]);
    mockSubjectFind.mockReturnValue(leanQuery([{ _id: SUBJECT_MATH, name: "Mathematics" }]));

    await getTeacherCascadeSubjectsService(TEACHER_A, "none", CLASS_9_BOYS, null, null, mockRes());
    expect(mockTestDistinct.mock.calls[0][1].session).toBe(null);
  });

  test("SECURITY regression: Science in 9th Boys must not be offered for a Math-only 11th assignment", async () => {
    mockPairs();
    // Tests in 11th Engineering cover Math AND Science (another teacher's).
    mockTestDistinct.mockResolvedValue([SUBJECT_MATH, SUBJECT_SCIENCE]);
    // Teacher A holds Math in 11th but NOT Science — the intersect must drop it.
    mockSubjectFind.mockReturnValue(leanQuery([{ _id: SUBJECT_MATH, name: "Mathematics" }]));

    const res = mockRes();
    await getTeacherCascadeSubjectsService(TEACHER_A, SESSION_1, CLASS_11_ENGINEERING, null, null, res);

    const scopedIds = mockSubjectFind.mock.calls[0][0]._id.$in.map(String);
    expect(scopedIds).toEqual([SUBJECT_MATH]);
  });
});

// ── Level 7: tests ───────────────────────────────────────────────────────────

describe("Cascade Level 7: getTeacherScopedTestsByClassSubjectService", () => {
  test("returns lean tests matching subject AND the selected class", async () => {
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });
    const expectedTests = [
      { _id: "test-1", name: "Math Quiz 1", date: new Date("2026-01-10") },
      { _id: "test-2", name: "Math Quiz 2", date: new Date("2026-01-17") },
    ];
    const chain = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(expectedTests),
    };
    mockTestFind.mockReturnValue(chain);

    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService(TEACHER_A, CLASS_9_BOYS, SUBJECT_MATH, null, null, null, res);

    const response = res.json.mock.calls[0][0];
    expect(response.status).toBe("success");
    expect(response.data).toHaveLength(2);
    const findCall = mockTestFind.mock.calls[0][0];
    expect(findCall.classLevels).toEqual({ $in: [CLASS_9_BOYS] });
    expect(findCall.subject).toBe(SUBJECT_MATH);
    // PERFORMANCE: lean() with the sort in the query — no populate chain.
    expect(chain.lean).toHaveBeenCalled();
    expect(chain.sort).toHaveBeenCalledWith({ date: -1 });
  });

  test("SECURITY: rejects when teacher is NOT assigned to this subject for any selected class", async () => {
    mockAssignmentFindOne.mockResolvedValue(null);
    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService(TEACHER_A, CLASS_9_GIRLS, SUBJECT_MATH, null, null, null, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockTestFind).not.toHaveBeenCalled();
  });

  test("SECURITY: teacher B cannot access teacher A's class+subject combo", async () => {
    mockAssignmentFindOne.mockResolvedValue(null);
    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService("teacher-b-id", CLASS_9_BOYS, SUBJECT_MATH, null, null, null, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("returns 400 when classLevel or subject is missing", async () => {
    const res = mockRes();
    await getTeacherScopedTestsByClassSubjectService(TEACHER_A, null, SUBJECT_MATH, null, null, null, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("\"none\" sentinels map to the no-category buckets", async () => {
    mockAssignmentFindOne.mockResolvedValue({ _id: "assign-1" });
    mockTestFind.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });

    await getTeacherScopedTestsByClassSubjectService(TEACHER_A, CLASS_9_BOYS, SUBJECT_MATH, "none", "none", "none", mockRes());
    const findCall = mockTestFind.mock.calls[0][0];
    expect(findCall.session).toBe(null);
    expect(findCall.phase).toBe(null);
    expect(findCall.week).toBe(null);
  });
});
