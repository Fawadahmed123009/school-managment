/**
 * Tests that the teacher analytics service is properly scoped:
 *
 * - Teacher sees only their assigned subjects' test data.
 * - Teacher cannot see another teacher's class/subject data.
 * - Per-class averages are computed correctly.
 * - Session filter scopes correctly.
 * - Class filter accepts multiple comma-separated sections and whole-grade tokens.
 * - Teacher with no assignments gets empty result.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockAssignmentFind = jest.fn();
const mockTestFind = jest.fn();
const mockTestResultFind = jest.fn();
const mockClassLevelFind = jest.fn();
const mockSubjectFind = jest.fn();
const mockTestSessionFind = jest.fn();

jest.mock("../models/Academic/assignment.model", () => ({
  find: (...a) => mockAssignmentFind(...a),
}));
jest.mock("../models/Academic/test.model", () => ({
  find: (...a) => mockTestFind(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockTestResultFind(...a),
}));
jest.mock("../models/Academic/class.model", () => ({
  find: (...a) => mockClassLevelFind(...a),
}));
jest.mock("../models/Academic/subject.model", () => ({
  find: (...a) => mockSubjectFind(...a),
}));
jest.mock("../models/Academic/testSession.model", () => ({
  find: (...a) => mockTestSessionFind(...a),
}));

// Need to mock Student model since test.service.js imports it
jest.mock("../models/Students/students.model", () => ({
  find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnThis(), populate: jest.fn().mockReturnThis(), sort: jest.fn().mockResolvedValue([]), lean: jest.fn().mockResolvedValue([]) }),
  countDocuments: jest.fn().mockResolvedValue(0),
}));

const { getTeacherAnalyticsService } = require("../services/academic/test.service");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SUBJECT_MATH = "507f1f77bcf86cd799439011";
const SUBJECT_ENG = "507f1f77bcf86cd799439022";
const CLASS_A = "507f1f77bcf86cd799439033";
const CLASS_B = "507f1f77bcf86cd799439044";
const CLASS_G9A = "507f1f77bcf86cd799439055";
const CLASS_G9B = "507f1f77bcf86cd799439066";
const TEACHER_A = "teacher-a";
const TEACHER_B = "teacher-b";

// Helper to create a classLevel object that behaves like a Mongoose doc
function makeClassLevel(id, name) {
  return { _id: id, name, toString: () => id };
}

const ASSIGNMENTS_TEACHER_A = [
  { teacher: TEACHER_A, subject: SUBJECT_MATH, classLevel: CLASS_A },
];

const ASSIGNMENTS_TEACHER_B = [
  { teacher: TEACHER_B, subject: SUBJECT_ENG, classLevel: CLASS_B },
];

// Teaches every section of grade 9 — used to exercise the whole-grade filter.
const ASSIGNMENTS_GRADE_TEACHER = [
  { teacher: "teacher-grade", subject: SUBJECT_MATH, classLevel: CLASS_G9A },
  { teacher: "teacher-grade", subject: SUBJECT_MATH, classLevel: CLASS_G9B },
];

const TEST_MATH_A = {
  _id: "test-math-a",
  subject: { _id: SUBJECT_MATH, name: "Math" },
  classLevels: [{ _id: CLASS_A, name: "Class A" }],
  session: { _id: "session-1", name: "Midterm" },
  totalMarks: 100,
  date: new Date("2025-06-15"),
};

const TEST_ENG_B = {
  _id: "test-eng-b",
  subject: { _id: SUBJECT_ENG, name: "English" },
  classLevels: [{ _id: CLASS_B, name: "Class B" }],
  session: { _id: "session-1", name: "Midterm" },
  totalMarks: 100,
  date: new Date("2025-06-15"),
};

const RESULTS_MATH = [
  { _id: "r1", test: "test-math-a", student: { _id: "s1", name: "Student 1", studentId: "STU-1", classLevel: makeClassLevel(CLASS_A, "Class A") }, score: 80 },
  { _id: "r2", test: "test-math-a", student: { _id: "s2", name: "Student 2", studentId: "STU-2", classLevel: makeClassLevel(CLASS_A, "Class A") }, score: 60 },
];

const RESULTS_ENG = [
  { _id: "r3", test: "test-eng-b", student: { _id: "s3", name: "Student 3", studentId: "STU-3", classLevel: makeClassLevel(CLASS_B, "Class B") }, score: 90 },
];

const TEST_G9 = {
  _id: "test-g9",
  subject: { _id: SUBJECT_MATH, name: "Math" },
  classLevels: [{ _id: CLASS_G9A, name: "9-A" }, { _id: CLASS_G9B, name: "9-B" }],
  session: { _id: "session-1", name: "Midterm" },
  totalMarks: 100,
  date: new Date("2025-06-15"),
};

const CLASSES_G9 = [
  { _id: CLASS_G9A, name: "9-A", gradeLevel: "9", toString: () => CLASS_G9A },
  { _id: CLASS_G9B, name: "9-B", gradeLevel: "9", toString: () => CLASS_G9B },
];

const RESULTS_G9 = [
  { _id: "rg1", test: "test-g9", student: { _id: "s91", name: "A One", studentId: "STU-91", classLevel: makeClassLevel(CLASS_G9A, "9-A") }, score: 70 },
  { _id: "rg2", test: "test-g9", student: { _id: "s92", name: "B One", studentId: "STU-92", classLevel: makeClassLevel(CLASS_G9B, "9-B") }, score: 50 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function setupAssignmentMock(teacherId, assignments) {
  mockAssignmentFind.mockImplementation((query) => {
    const filtered = assignments.filter((a) => {
      if (query.teacher && a.teacher !== query.teacher) return false;
      return true;
    });
    return {
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(filtered),
    };
  });
}

function setupClassLevelFind(classes) {
  // Supports both query shapes used by the service:
  //   { _id: { $in } } (dropdown load) and { _id: { $in }, gradeLevel } (grade expansion)
  const makeChain = (query) => {
    let out = classes;
    if (query && query._id && query._id.$in) {
      const ids = query._id.$in.map(String);
      out = out.filter((c) => ids.includes(String(c._id)));
    }
    if (query && query.gradeLevel) {
      out = out.filter((c) => String(c.gradeLevel) === String(query.gradeLevel));
    }
    const chain = {
      select: jest.fn().mockImplementation(() => makeChain(query)),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(out),
    };
    return chain;
  };
  mockClassLevelFind.mockImplementation((query) => makeChain(query));
}

function setupSubjectFind(subjects) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(subjects),
  };
  mockSubjectFind.mockReturnValue(chain);
}

function setupTestSessionFind(sessions) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(sessions),
  };
  mockTestSessionFind.mockReturnValue(chain);
}

function setupTestFind(tests) {
  const chain = {
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(tests),
  };
  mockTestFind.mockReturnValue(chain);
}

function setupTestResultFind(results) {
  const chain = {
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(results),
  };
  mockTestResultFind.mockReturnValue(chain);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────
describe("getTeacherAnalyticsService — assignment scoping", () => {
  test("teacher sees only their assigned subjects' test data", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_A, ASSIGNMENTS_TEACHER_A);
    setupClassLevelFind([{ _id: CLASS_A, name: "Class A" }]);
    setupSubjectFind([{ _id: SUBJECT_MATH, name: "Math" }]);
    setupTestSessionFind([{ _id: "session-1", name: "Midterm" }]);
    setupTestFind([TEST_MATH_A]);
    setupTestResultFind(RESULTS_MATH);

    await getTeacherAnalyticsService(TEACHER_A, {}, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.data.perClass).toHaveLength(1);
    expect(body.data.perClass[0].className).toBe("Class A");
    // avg = (80 + 60) / 2 = 70%
    expect(body.data.perClass[0].avg).toBe(70);
    expect(body.data.perClass[0].min).toBe(60);
    expect(body.data.perClass[0].max).toBe(80);
  });

  test("teacher cannot see another teacher's class/subject data", async () => {
    const res = mockRes();
    // Teacher A is only assigned Math/Class A
    setupAssignmentMock(TEACHER_A, ASSIGNMENTS_TEACHER_A);
    setupClassLevelFind([{ _id: CLASS_A, name: "Class A" }]);
    setupSubjectFind([{ _id: SUBJECT_MATH, name: "Math" }]);
    setupTestSessionFind([{ _id: "session-1", name: "Midterm" }]);
    // The test query only returns Math tests (scoped by subject)
    setupTestFind([TEST_MATH_A]);
    setupTestResultFind(RESULTS_MATH);

    await getTeacherAnalyticsService(TEACHER_A, {}, res);

    const body = res.json.mock.calls[0][0];
    // Should only have Class A data, never Class B
    const classNames = body.data.perClass.map((c) => c.className);
    expect(classNames).toContain("Class A");
    expect(classNames).not.toContain("Class B");
  });

  test("teacher with no assignments gets empty result", async () => {
    const res = mockRes();
    setupAssignmentMock("teacher-none", []);
    setupClassLevelFind([]);
    setupSubjectFind([]);
    setupTestSessionFind([]);

    await getTeacherAnalyticsService("teacher-none", {}, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("success");
    expect(body.data.perClass).toEqual([]);
    expect(body.data.perSession).toEqual([]);
    expect(body.data.overallStats).toBeNull();
  });

  test("class filter rejects class not in assignment set (403)", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_A, ASSIGNMENTS_TEACHER_A);

    await getTeacherAnalyticsService(TEACHER_A, { classLevel: CLASS_B }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/not assigned/i);
  });

  test("subject filter rejects subject not in assignment set (403)", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_A, ASSIGNMENTS_TEACHER_A);

    await getTeacherAnalyticsService(TEACHER_A, { subject: SUBJECT_ENG }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/not assigned/i);
  });

  test("whole-grade filter aggregates every section of that grade", async () => {
    const res = mockRes();
    setupAssignmentMock("teacher-grade", ASSIGNMENTS_GRADE_TEACHER);
    setupClassLevelFind(CLASSES_G9);
    setupSubjectFind([{ _id: SUBJECT_MATH, name: "Math" }]);
    setupTestSessionFind([{ _id: "session-1", name: "Midterm" }]);
    setupTestFind([TEST_G9]);
    setupTestResultFind(RESULTS_G9);

    await getTeacherAnalyticsService("teacher-grade", { classLevel: "grade:9" }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    // Both sections of grade 9 appear in the breakdown
    const classNames = body.data.perClass.map((c) => c.className).sort();
    expect(classNames).toEqual(["9-A", "9-B"]);
    // overall avg = (70 + 50) / 2 = 60%
    expect(body.data.overallStats.avg).toBe(60);
    expect(body.data.overallStats.count).toBe(2);
  });

  test("whole-grade filter rejects a grade the teacher has no class in (403)", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_A, ASSIGNMENTS_TEACHER_A);
    setupClassLevelFind([{ _id: CLASS_A, name: "Class A", gradeLevel: "10" }]);

    await getTeacherAnalyticsService(TEACHER_A, { classLevel: "grade:9" }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/grade 9/i);
  });

  test("multi-select filter combines several sections via comma tokens", async () => {
    const res = mockRes();
    setupAssignmentMock("teacher-grade", ASSIGNMENTS_GRADE_TEACHER);
    setupClassLevelFind(CLASSES_G9);
    setupSubjectFind([{ _id: SUBJECT_MATH, name: "Math" }]);
    setupTestSessionFind([{ _id: "session-1", name: "Midterm" }]);
    setupTestFind([TEST_G9]);
    setupTestResultFind(RESULTS_G9);

    await getTeacherAnalyticsService("teacher-grade", { classLevel: CLASS_G9A + "," + CLASS_G9B }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    const classNames = body.data.perClass.map((c) => c.className).sort();
    expect(classNames).toEqual(["9-A", "9-B"]);

    // A single selected section narrows the breakdown to just that class
    const res2 = mockRes();
    await getTeacherAnalyticsService("teacher-grade", { classLevel: CLASS_G9A }, res2);
    const body2 = res2.json.mock.calls[0][0];
    expect(body2.data.perClass.map((c) => c.className)).toEqual(["9-A"]);
  });

  test("multi-select filter rejects the batch if any token is out of scope", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_A, ASSIGNMENTS_TEACHER_A);

    await getTeacherAnalyticsService(TEACHER_A, { classLevel: CLASS_A + "," + CLASS_B }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].message).toMatch(/not assigned/i);
  });

  test("per-session averages are computed correctly", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_A, ASSIGNMENTS_TEACHER_A);
    setupClassLevelFind([{ _id: CLASS_A, name: "Class A" }]);
    setupSubjectFind([{ _id: SUBJECT_MATH, name: "Math" }]);
    setupTestSessionFind([{ _id: "session-1", name: "Midterm" }]);
    setupTestFind([TEST_MATH_A]);
    setupTestResultFind(RESULTS_MATH);

    await getTeacherAnalyticsService(TEACHER_A, {}, res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.perSession).toHaveLength(1);
    expect(body.data.perSession[0].sessionName).toBe("Midterm");
    // avg = (80 + 60) / 2 = 70%
    expect(body.data.perSession[0].avg).toBe(70);
  });

  test("overall stats are computed correctly", async () => {
    const res = mockRes();
    setupAssignmentMock(TEACHER_A, ASSIGNMENTS_TEACHER_A);
    setupClassLevelFind([{ _id: CLASS_A, name: "Class A" }]);
    setupSubjectFind([{ _id: SUBJECT_MATH, name: "Math" }]);
    setupTestSessionFind([{ _id: "session-1", name: "Midterm" }]);
    setupTestFind([TEST_MATH_A]);
    setupTestResultFind(RESULTS_MATH);

    await getTeacherAnalyticsService(TEACHER_A, {}, res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.overallStats).not.toBeNull();
    expect(body.data.overallStats.avg).toBe(70);
    expect(body.data.overallStats.min).toBe(60);
    expect(body.data.overallStats.max).toBe(80);
    expect(body.data.overallStats.count).toBe(2);
  });
});
