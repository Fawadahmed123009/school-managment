/**
 * Tests that the mark-entry roster and score-submission are scoped to only the
 * sections a teacher is actually assigned to — not every section a test covers.
 *
 * Scenario: a multi-section test spanning Boys + Girls, with a teacher assigned
 * (for the test's subject) to ONLY the Boys section.
 *
 *   • The roster must list Boys students only — never Girls.
 *   • A teacher assigned to no section of the test is refused (403).
 *   • Submitting scores for in-scope (Boys) students succeeds.
 *   • Submitting a score for an out-of-scope (Girls) student is rejected (403)
 *     and writes nothing — hiding the rows isn't enough; the write path enforces it.
 *   • A batch mixing in- and out-of-scope students is rejected wholesale.
 *
 * Models are mocked at the data layer so the real intersection logic
 * (getAssignedClassLevels) and the real service filtering both execute.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockTestFindById = jest.fn();
const mockStudentFind = jest.fn();
const mockResultFind = jest.fn();
const mockResultFindOneAndUpdate = jest.fn();
const mockAssignmentFind = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  findById: (...a) => mockTestFindById(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockResultFind(...a),
  findOneAndUpdate: (...a) => mockResultFindOneAndUpdate(...a),
}));
jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  find: (...a) => mockAssignmentFind(...a),
}));

const {
  getTestRosterService,
  submitTestResultsService,
} = require("../services/academic/test.service");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SUBJECT = "sub-math";
const CLASS_BOYS = "cls-boys";
const CLASS_GIRLS = "cls-girls";
const TEACHER = "teacher-boys";       // assigned to Boys only
const UNASSIGNED_TEACHER = "teacher-none";

const STUDENTS = [
  { _id: "b1", name: "Boy One", studentId: "STU-B1", classLevel: CLASS_BOYS },
  { _id: "b2", name: "Boy Two", studentId: "STU-B2", classLevel: CLASS_BOYS },
  { _id: "g1", name: "Girl One", studentId: "STU-G1", classLevel: CLASS_GIRLS },
  { _id: "g2", name: "Girl Two", studentId: "STU-G2", classLevel: CLASS_GIRLS },
];

// Teacher is assigned ONLY to the Boys section for this subject.
const ASSIGNMENTS = [{ teacher: TEACHER, subject: SUBJECT, classLevel: CLASS_BOYS }];

// A single test that covers BOTH sections.
const MULTI_SECTION_TEST = {
  _id: "test-1",
  subject: SUBJECT,
  classLevels: [CLASS_BOYS, CLASS_GIRLS],
  totalMarks: 100,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();

  mockTestFindById.mockResolvedValue(MULTI_SECTION_TEST);

  // Assignment.find({ teacher, subject, classLevel: { $in } }).select("classLevel")
  mockAssignmentFind.mockImplementation((q) => {
    const ids = (q.classLevel && q.classLevel.$in ? q.classLevel.$in : []).map(String);
    const matches = ASSIGNMENTS.filter(
      (a) =>
        String(a.teacher) === String(q.teacher) &&
        String(a.subject) === String(q.subject) &&
        ids.includes(String(a.classLevel))
    );
    return { select: jest.fn().mockResolvedValue(matches.map((a) => ({ classLevel: a.classLevel }))) };
  });

  // Student.find(...).select(...) — supports { classLevel: { $in } } and { _id: { $in } }
  mockStudentFind.mockImplementation((q) => {
    let out = STUDENTS.slice();
    if (q.classLevel && q.classLevel.$in) {
      const cls = q.classLevel.$in.map(String);
      out = out.filter((s) => cls.includes(String(s.classLevel)));
    }
    if (q._id && q._id.$in) {
      const ids = q._id.$in.map(String);
      out = out.filter((s) => ids.includes(String(s._id)));
    }
    return { select: jest.fn().mockResolvedValue(out) };
  });

  mockResultFind.mockResolvedValue([]); // no pre-existing scores
  mockResultFindOneAndUpdate.mockImplementation(async (_q, doc) => doc);
});

// ── Roster scoping ───────────────────────────────────────────────────────────
describe("getTestRosterService — roster scoped to the teacher's own sections", () => {
  test("teacher assigned to only Boys sees Boys students, never Girls", async () => {
    const res = mockRes();
    await getTestRosterService("test-1", TEACHER, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");

    const ids = body.data.roster.map((r) => String(r.student)).sort();
    expect(ids).toEqual(["b1", "b2"]);
    expect(ids).not.toContain("g1");
    expect(ids).not.toContain("g2");
  });

  test("teacher assigned to no section of the test is refused (403)", async () => {
    const res = mockRes();
    await getTestRosterService("test-1", UNASSIGNED_TEACHER, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/not assigned/i);
  });
});

// ── Submission scoping ───────────────────────────────────────────────────────
describe("submitTestResultsService — write path enforces section scope", () => {
  test("scores for in-scope (Boys) students are saved", async () => {
    const res = mockRes();
    await submitTestResultsService(
      "test-1",
      [{ student: "b1", score: 80 }, { student: "b2", score: 75 }],
      TEACHER,
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].status).toBe("success");
    expect(mockResultFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  test("a score for an out-of-scope (Girls) student is rejected (403) and writes nothing", async () => {
    const res = mockRes();
    await submitTestResultsService("test-1", [{ student: "g1", score: 90 }], TEACHER, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/sections you are assigned to/i);
    expect(mockResultFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("a batch mixing in- and out-of-scope students is rejected wholesale (no partial write)", async () => {
    const res = mockRes();
    await submitTestResultsService(
      "test-1",
      [{ student: "b1", score: 50 }, { student: "g1", score: 90 }],
      TEACHER,
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockResultFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
