/**
 * Regression tests for the at-risk student alerts service.
 *
 * Covers two areas:
 *
 *   1. Threshold logic — attendance < 75 % and per-subject average < 40 %
 *      trigger flags; values at or above the thresholds do NOT.
 *
 *   2. Access-boundary scoping — a teacher only sees flags for students in
 *      their assigned classes, and only for subjects they teach.  An admin
 *      sees school-wide data.  The teacher must NEVER see a student flagged
 *      for a subject they don't teach (e.g. a Math teacher must not see a
 *      Chemistry flag).
 *
 * Models are mocked at the data layer so the real service logic executes
 * with no database — same pattern as teacherAnalyticsScope.test.js and
 * teacherAttendanceScope.test.js.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockAttendanceAggregate = jest.fn();
const mockTestResultFind = jest.fn();
const mockStudentFind = jest.fn();
const mockAssignmentFind = jest.fn();

jest.mock("../models/Academic/attendance.model", () => ({
  aggregate: (...a) => mockAttendanceAggregate(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockTestResultFind(...a),
}));
jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  find: (...a) => mockAssignmentFind(...a),
}));

const {
  getAtRiskStudentsAdmin,
  getAtRiskStudentsTeacher,
  THRESHOLDS,
} = require("../services/alerts/atRiskAlerts.service");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CLASS_A = "507f1f77bcf86cd799439011";
const CLASS_B = "507f1f77bcf86cd799439022";
const CLASS_C = "507f1f77bcf86cd799439099";

const SUBJECT_MATH = "507f1f77bcf86cd799439033";
const SUBJECT_CHEM = "507f1f77bcf86cd799439044";
const SUBJECT_ENG  = "507f1f77bcf86cd799439055";

const TEACHER_MATH = "teacher-math";
const TEACHER_CHEM = "teacher-chem";

// Student helpers
function makeStudent(id, name, classId, className) {
  return {
    _id: id,
    name,
    studentId: `STU-${id}`,
    rollNumber: Math.floor(Math.random() * 100),
    classLevel: { _id: classId, name: className, toString: () => classId },
    toString: () => id,
  };
}

// Test-result helper (populated shape)
function makeResult(studentId, subjectId, subjectName, score, totalMarks) {
  return {
    student: { toString: () => studentId },
    test: {
      subject: { _id: subjectId, name: subjectName, toString: () => subjectId },
      totalMarks,
    },
    score,
  };
}

// Attendance-aggregation row
function makeAttRow(studentId, present, absent, late) {
  return { _id: { toString: () => studentId }, present, absent, late };
}

// ── Mock wiring helpers ──────────────────────────────────────────────────────
function setupAttendanceAggregate(rows) {
  mockAttendanceAggregate.mockResolvedValue(rows);
}

function setupStudentFind(students) {
  mockStudentFind.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(students),
  });
}

function setupTestResultFind(results) {
  mockTestResultFind.mockReturnValue({
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(results),
  });
}

function setupAssignmentFind(assignments) {
  mockAssignmentFind.mockReturnValue({
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(assignments),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// THRESHOLDS export
// ═════════════════════════════════════════════════════════════════════════════
describe("THRESHOLDS", () => {
  test("exports ATTENDANCE = 75 and SCORE = 40", () => {
    expect(THRESHOLDS.ATTENDANCE).toBe(75);
    expect(THRESHOLDS.SCORE).toBe(40);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN — threshold logic
// ═════════════════════════════════════════════════════════════════════════════
describe("getAtRiskStudentsAdmin — threshold logic", () => {
  test("flags student with attendance below 75%", async () => {
    const s1 = makeStudent("s1", "Alice", CLASS_A, "Class A");
    setupStudentFind([s1]);
    // 6 present + 0 late = 60% out of 10 days
    setupAttendanceAggregate([makeAttRow("s1", 6, 4, 0)]);
    setupTestResultFind([]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.total).toBe(1);
    expect(result.students).toHaveLength(1);
    expect(result.students[0].student.name).toBe("Alice");
    expect(result.students[0].reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "attendance", value: 60 })])
    );
  });

  test("flags student with per-subject average below 40%", async () => {
    const s1 = makeStudent("s1", "Bob", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 10, 0, 0)]); // 100% attendance — fine
    // Chemistry: 30/100 = 30%  → flagged
    setupTestResultFind([makeResult("s1", SUBJECT_CHEM, "Chemistry", 30, 100)]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.total).toBe(1);
    const scoreReasons = result.students[0].reasons.filter((r) => r.type === "score");
    expect(scoreReasons).toHaveLength(1);
    expect(scoreReasons[0].subject).toBe("Chemistry");
    expect(scoreReasons[0].value).toBe(30);
  });

  test("does NOT flag student at or above both thresholds", async () => {
    const s1 = makeStudent("s1", "Carol", CLASS_A, "Class A");
    setupStudentFind([s1]);
    // 80% attendance — above 75%
    setupAttendanceAggregate([makeAttRow("s1", 8, 2, 0)]);
    // Math 60%, Science 55% — both above 40%
    setupTestResultFind([
      makeResult("s1", SUBJECT_MATH, "Math", 60, 100),
      makeResult("s1", SUBJECT_CHEM, "Chemistry", 55, 100),
    ]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.total).toBe(0);
    expect(result.students).toHaveLength(0);
  });

  test("does NOT flag attendance at exactly 75% (boundary)", async () => {
    const s1 = makeStudent("s1", "Dave", CLASS_A, "Class A");
    setupStudentFind([s1]);
    // 6 present + 0 late + 2 absent = 6/8 = 75% exactly
    setupAttendanceAggregate([makeAttRow("s1", 6, 2, 0)]);
    setupTestResultFind([]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.total).toBe(0);
  });

  test("does NOT flag per-subject average at exactly 40% (boundary)", async () => {
    const s1 = makeStudent("s1", "Eve", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 10, 0, 0)]);
    // 40/100 = 40% exactly — should NOT be flagged (< 40, not <=)
    setupTestResultFind([makeResult("s1", SUBJECT_MATH, "Math", 40, 100)]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.total).toBe(0);
  });

  test("late counts as present in attendance %", async () => {
    const s1 = makeStudent("s1", "Frank", CLASS_A, "Class A");
    setupStudentFind([s1]);
    // 5 present + 3 late = 8/10 = 80% → NOT flagged
    setupAttendanceAggregate([makeAttRow("s1", 5, 2, 3)]);
    setupTestResultFind([]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.total).toBe(0);
  });

  test("each low subject generates a separate reason entry", async () => {
    const s1 = makeStudent("s1", "Grace", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 10, 0, 0)]);
    // Math 30%, Chemistry 20%, English 50%
    setupTestResultFind([
      makeResult("s1", SUBJECT_MATH, "Math", 30, 100),
      makeResult("s1", SUBJECT_CHEM, "Chemistry", 20, 100),
      makeResult("s1", SUBJECT_ENG, "English", 50, 100),
    ]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.total).toBe(1);
    const scoreReasons = result.students[0].reasons.filter((r) => r.type === "score");
    expect(scoreReasons).toHaveLength(2); // Math + Chemistry, NOT English
    const subjects = scoreReasons.map((r) => r.subject).sort();
    expect(subjects).toEqual(["Chemistry", "Math"]);
  });

  test("multiple test scores in same subject are averaged", async () => {
    const s1 = makeStudent("s1", "Hank", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 10, 0, 0)]);
    // Math: 20/100 = 20% and 40/100 = 40% → avg = 30% → flagged
    setupTestResultFind([
      makeResult("s1", SUBJECT_MATH, "Math", 20, 100),
      makeResult("s1", SUBJECT_MATH, "Math", 40, 100),
    ]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.total).toBe(1);
    const mathReason = result.students[0].reasons.find((r) => r.subject === "Math");
    expect(mathReason).toBeDefined();
    expect(mathReason.value).toBe(30);
  });

  test("class filter restricts which students are evaluated", async () => {
    // Only Class A students returned by Student.find
    const s1 = makeStudent("s1", "Ivy", CLASS_A, "Class A");
    setupStudentFind([s1]);
    // Even though attendance agg has data for Class B student, they're not in the student list
    setupAttendanceAggregate([
      makeAttRow("s1", 5, 5, 0),   // 50% → flagged
      makeAttRow("s2", 5, 5, 0),   // 50% but not in student list
    ]);
    setupTestResultFind([]);

    const result = await getAtRiskStudentsAdmin(CLASS_A);

    expect(result.total).toBe(1);
    expect(result.students[0].student.name).toBe("Ivy");
  });

  test("returns empty result when no students exist", async () => {
    setupStudentFind([]);
    setupAttendanceAggregate([]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.total).toBe(0);
    expect(result.students).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("result shape is { students, total, hasMore }", async () => {
    setupStudentFind([]);
    setupAttendanceAggregate([]);

    const result = await getAtRiskStudentsAdmin();

    expect(result).toHaveProperty("students");
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("hasMore");
    expect(Array.isArray(result.students)).toBe(true);
  });

  test("list is capped at 10 with hasMore = true when more exist", async () => {
    // Create 12 at-risk students (all with 50% attendance)
    const students = Array.from({ length: 12 }, (_, i) =>
      makeStudent(`s${i}`, `Student ${i}`, CLASS_A, "Class A")
    );
    setupStudentFind(students);
    setupAttendanceAggregate(
      students.map((_, i) => makeAttRow(`s${i}`, 5, 5, 0))
    );
    setupTestResultFind([]);

    const result = await getAtRiskStudentsAdmin();

    expect(result.students).toHaveLength(10);
    expect(result.total).toBe(12);
    expect(result.hasMore).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEACHER — assignment scoping
// ═════════════════════════════════════════════════════════════════════════════
describe("getAtRiskStudentsTeacher — assignment scoping", () => {
  // Teacher A: Math in Class A only
  const ASSIGNMENTS_MATH_A = [
    {
      teacher: TEACHER_MATH,
      subject: { _id: SUBJECT_MATH, name: "Math", toString: () => SUBJECT_MATH },
      classLevel: { _id: CLASS_A, name: "Class A", toString: () => CLASS_A },
    },
  ];

  // Teacher B: Chemistry in Class B only
  const ASSIGNMENTS_CHEM_B = [
    {
      teacher: TEACHER_CHEM,
      subject: { _id: SUBJECT_CHEM, name: "Chemistry", toString: () => SUBJECT_CHEM },
      classLevel: { _id: CLASS_B, name: "Class B", toString: () => CLASS_B },
    },
  ];

  test("teacher only sees students in their assigned classes", async () => {
    // Math teacher assigned to Class A
    setupAssignmentFind(ASSIGNMENTS_MATH_A);
    // Only Class A students returned
    const s1 = makeStudent("s1", "Alice", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 5, 5, 0)]); // 50% → flagged
    setupTestResultFind([]);

    const result = await getAtRiskStudentsTeacher(TEACHER_MATH);

    expect(result.total).toBe(1);
    expect(result.students[0].student.name).toBe("Alice");
    expect(result.students[0].student.className).toBe("Class A");
  });

  test("teacher does NOT see students from other classes", async () => {
    // Math teacher assigned to Class A only
    setupAssignmentFind(ASSIGNMENTS_MATH_A);
    // Student.find returns students from Class A (scoped by query)
    const s1 = makeStudent("s1", "Alice", CLASS_A, "Class A");
    setupStudentFind([s1]);
    // Attendance agg is scoped to classLevelIds, so only Class A data
    setupAttendanceAggregate([makeAttRow("s1", 5, 5, 0)]);
    setupTestResultFind([]);

    const result = await getAtRiskStudentsTeacher(TEACHER_MATH);

    // No Class B students should appear
    const classNames = result.students.map((r) => r.student.className);
    expect(classNames).not.toContain("Class B");
  });

  test("teacher does NOT see score flags for subjects they don't teach", async () => {
    // Math teacher assigned to Class A — teaches ONLY Math
    setupAssignmentFind(ASSIGNMENTS_MATH_A);
    const s1 = makeStudent("s1", "Bob", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 10, 0, 0)]); // 100% attendance — fine

    // Student has low Chemistry (20%) but also low Math (30%)
    // The teacher should ONLY see the Math flag, not Chemistry
    setupTestResultFind([
      makeResult("s1", SUBJECT_MATH, "Math", 30, 100),      // 30% → Math teacher sees this
      makeResult("s1", SUBJECT_CHEM, "Chemistry", 20, 100),  // 20% → Math teacher must NOT see this
    ]);

    const result = await getAtRiskStudentsTeacher(TEACHER_MATH);

    expect(result.total).toBe(1);
    const reasons = result.students[0].reasons;
    const scoreReasons = reasons.filter((r) => r.type === "score");

    // Only Math should appear — Chemistry must be filtered out
    expect(scoreReasons).toHaveLength(1);
    expect(scoreReasons[0].subject).toBe("Math");
    expect(scoreReasons[0].subject).not.toBe("Chemistry");
  });

  test("teacher sees NO flags if student is fine in teacher's subject only", async () => {
    // Math teacher — student has 90% attendance and 80% in Math
    setupAssignmentFind(ASSIGNMENTS_MATH_A);
    const s1 = makeStudent("s1", "Carol", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 9, 1, 0)]); // 90% — fine
    // Math 80% — fine. Chemistry 20% — but teacher doesn't teach Chemistry
    setupTestResultFind([
      makeResult("s1", SUBJECT_MATH, "Math", 80, 100),
      makeResult("s1", SUBJECT_CHEM, "Chemistry", 20, 100),
    ]);

    const result = await getAtRiskStudentsTeacher(TEACHER_MATH);

    // Student should NOT be flagged at all — Math is fine, attendance is fine,
    // and Chemistry is invisible to the Math teacher
    expect(result.total).toBe(0);
    expect(result.students).toHaveLength(0);
  });

  test("teacher with no assignments gets empty result", async () => {
    setupAssignmentFind([]);

    const result = await getAtRiskStudentsTeacher("teacher-nobody");

    expect(result.total).toBe(0);
    expect(result.students).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    // Verify no further model calls were made (early return)
    expect(mockAttendanceAggregate).not.toHaveBeenCalled();
    expect(mockTestResultFind).not.toHaveBeenCalled();
  });

  test("Chemistry teacher only sees Chemistry flags, not Math flags", async () => {
    // Chemistry teacher assigned to Class B
    setupAssignmentFind(ASSIGNMENTS_CHEM_B);
    const s1 = makeStudent("s1", "Dave", CLASS_B, "Class B");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 10, 0, 0)]); // 100% — fine

    // Student has low Math (20%) and low Chemistry (30%)
    setupTestResultFind([
      makeResult("s1", SUBJECT_MATH, "Math", 20, 100),       // 20% → Chem teacher must NOT see
      makeResult("s1", SUBJECT_CHEM, "Chemistry", 30, 100),   // 30% → Chem teacher sees this
    ]);

    const result = await getAtRiskStudentsTeacher(TEACHER_CHEM);

    expect(result.total).toBe(1);
    const scoreReasons = result.students[0].reasons.filter((r) => r.type === "score");
    expect(scoreReasons).toHaveLength(1);
    expect(scoreReasons[0].subject).toBe("Chemistry");
  });

  test("teacher with multi-class assignment sees students from all their classes", async () => {
    // Teacher teaches Math in both Class A and Class B
    const multiAssignments = [
      {
        teacher: TEACHER_MATH,
        subject: { _id: SUBJECT_MATH, name: "Math", toString: () => SUBJECT_MATH },
        classLevel: { _id: CLASS_A, name: "Class A", toString: () => CLASS_A },
      },
      {
        teacher: TEACHER_MATH,
        subject: { _id: SUBJECT_MATH, name: "Math", toString: () => SUBJECT_MATH },
        classLevel: { _id: CLASS_B, name: "Class B", toString: () => CLASS_B },
      },
    ];
    setupAssignmentFind(multiAssignments);

    const s1 = makeStudent("s1", "Eve", CLASS_A, "Class A");
    const s2 = makeStudent("s2", "Frank", CLASS_B, "Class B");
    setupStudentFind([s1, s2]);
    setupAttendanceAggregate([
      makeAttRow("s1", 5, 5, 0),  // 50% → flagged
      makeAttRow("s2", 6, 4, 0),  // 60% → flagged
    ]);
    setupTestResultFind([]);

    const result = await getAtRiskStudentsTeacher(TEACHER_MATH);

    expect(result.total).toBe(2);
    const names = result.students.map((r) => r.student.name).sort();
    expect(names).toEqual(["Eve", "Frank"]);
  });

  test("attendance aggregation is scoped to teacher's classLevelIds", async () => {
    setupAssignmentFind(ASSIGNMENTS_MATH_A); // Class A only
    const s1 = makeStudent("s1", "Grace", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 5, 5, 0)]);
    setupTestResultFind([]);

    await getAtRiskStudentsTeacher(TEACHER_MATH);

    // Verify the aggregation pipeline includes $match with classLevel $in [CLASS_A]
    const pipeline = mockAttendanceAggregate.mock.calls[0][0];
    const matchStage = pipeline.find((stage) => stage.$match);
    expect(matchStage).toBeDefined();
    expect(matchStage.$match.classLevel).toEqual({ $in: [CLASS_A] });
  });

  test("student.find is scoped to teacher's classLevelIds", async () => {
    setupAssignmentFind(ASSIGNMENTS_MATH_A); // Class A only
    setupStudentFind([]);
    setupAttendanceAggregate([]);

    await getAtRiskStudentsTeacher(TEACHER_MATH);

    // Verify Student.find was called with classLevel filter
    const findArg = mockStudentFind.mock.calls[0][0];
    expect(findArg.classLevel).toEqual({ $in: [CLASS_A] });
    expect(findArg.isWithdrawn).toEqual({ $ne: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEACHER — threshold logic (same thresholds as admin)
// ═════════════════════════════════════════════════════════════════════════════
describe("getAtRiskStudentsTeacher — threshold logic", () => {
  const ASSIGNMENTS = [
    {
      teacher: TEACHER_MATH,
      subject: { _id: SUBJECT_MATH, name: "Math", toString: () => SUBJECT_MATH },
      classLevel: { _id: CLASS_A, name: "Class A", toString: () => CLASS_A },
    },
  ];

  test("flags student with attendance below 75% in teacher's class", async () => {
    setupAssignmentFind(ASSIGNMENTS);
    const s1 = makeStudent("s1", "Alice", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 6, 4, 0)]); // 60%
    setupTestResultFind([]);

    const result = await getAtRiskStudentsTeacher(TEACHER_MATH);

    expect(result.total).toBe(1);
    expect(result.students[0].reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "attendance", value: 60 })])
    );
  });

  test("flags student with low score in teacher's subject", async () => {
    setupAssignmentFind(ASSIGNMENTS);
    const s1 = makeStudent("s1", "Bob", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 10, 0, 0)]);
    setupTestResultFind([makeResult("s1", SUBJECT_MATH, "Math", 25, 100)]); // 25%

    const result = await getAtRiskStudentsTeacher(TEACHER_MATH);

    expect(result.total).toBe(1);
    const scoreReason = result.students[0].reasons.find((r) => r.type === "score");
    expect(scoreReason).toBeDefined();
    expect(scoreReason.value).toBe(25);
  });

  test("does NOT flag student at exactly 75% attendance", async () => {
    setupAssignmentFind(ASSIGNMENTS);
    const s1 = makeStudent("s1", "Carol", CLASS_A, "Class A");
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 6, 2, 0)]); // 6/8 = 75%
    setupTestResultFind([]);

    const result = await getAtRiskStudentsTeacher(TEACHER_MATH);

    expect(result.total).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CROSS-TEACHER ISOLATION — the critical access-boundary test
// ═════════════════════════════════════════════════════════════════════════════
describe("cross-teacher isolation", () => {
  test("Math teacher and Chemistry teacher see completely different flags for same student", async () => {
    // Student in Class A has: 80% attendance, 30% Math, 25% Chemistry
    const s1 = makeStudent("s1", "Dave", CLASS_A, "Class A");

    // ── Math teacher (Class A, Math only) ──
    setupAssignmentFind([
      {
        teacher: TEACHER_MATH,
        subject: { _id: SUBJECT_MATH, name: "Math", toString: () => SUBJECT_MATH },
        classLevel: { _id: CLASS_A, name: "Class A", toString: () => CLASS_A },
      },
    ]);
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 8, 2, 0)]); // 80% — fine
    setupTestResultFind([
      makeResult("s1", SUBJECT_MATH, "Math", 30, 100),
      makeResult("s1", SUBJECT_CHEM, "Chemistry", 25, 100),
    ]);

    const mathResult = await getAtRiskStudentsTeacher(TEACHER_MATH);

    // ── Chemistry teacher (Class A, Chemistry only) ──
    jest.clearAllMocks();
    setupAssignmentFind([
      {
        teacher: TEACHER_CHEM,
        subject: { _id: SUBJECT_CHEM, name: "Chemistry", toString: () => SUBJECT_CHEM },
        classLevel: { _id: CLASS_A, name: "Class A", toString: () => CLASS_A },
      },
    ]);
    setupStudentFind([s1]);
    setupAttendanceAggregate([makeAttRow("s1", 8, 2, 0)]);
    setupTestResultFind([
      makeResult("s1", SUBJECT_MATH, "Math", 30, 100),
      makeResult("s1", SUBJECT_CHEM, "Chemistry", 25, 100),
    ]);

    const chemResult = await getAtRiskStudentsTeacher(TEACHER_CHEM);

    // Math teacher sees ONLY Math flag
    expect(mathResult.total).toBe(1);
    const mathScoreReasons = mathResult.students[0].reasons.filter((r) => r.type === "score");
    expect(mathScoreReasons).toHaveLength(1);
    expect(mathScoreReasons[0].subject).toBe("Math");

    // Chemistry teacher sees ONLY Chemistry flag
    expect(chemResult.total).toBe(1);
    const chemScoreReasons = chemResult.students[0].reasons.filter((r) => r.type === "score");
    expect(chemScoreReasons).toHaveLength(1);
    expect(chemScoreReasons[0].subject).toBe("Chemistry");

    // Neither sees the other's subject
    expect(mathScoreReasons[0].subject).not.toBe("Chemistry");
    expect(chemScoreReasons[0].subject).not.toBe("Math");
  });
});
