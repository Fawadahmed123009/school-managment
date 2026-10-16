/**
 * Dashboard refinements — at-risk grade filter + marking grace window (pure logic).
 *
 *  1. getAtRiskStudentsAdmin(classLevelId, sortBy, gradeLevel, options)
 *     The third argument restricts the population to a grade's classes (API
 *     kept for tests/tooling); the dashboard now uses options.maxList = null
 *     instead: ONE uncapped ranked scan (every row carries student.gradeLevel)
 *     that the route buckets per grade tab for client-side toggling.
 *     Flagging is MARKS-ONLY (per-subject average < 40 %); attendance % is
 *     returned for display but never flags.
 *
 *  2. isBeyondMarkingGrace(date)
 *     The "Tests awaiting marking" panel only lists tests held MORE than 3
 *     days ago — anything inside the grace window must not appear.
 *
 * Models are mocked at the data layer — same pattern as atRiskAlerts.test.js.
 */

const mockClassFindForGrade = jest.fn();

jest.mock("../models/Academic/class.model", () => ({
  // Service calls ClassLevel.find({ gradeLevel }).select("_id").lean() —
  // expose the resolved docs through a select().lean() chain.
  find: (...a) => {
    const docsPromise = mockClassFindForGrade(...a);
    return { select: () => ({ lean: () => docsPromise }) };
  },
}));

const mockAttendanceAggregate = jest.fn();
const mockTestResultFind = jest.fn();
const mockStudentFind = jest.fn();

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
  find: () => ({ populate: () => ({ populate: () => ({ lean: () => Promise.resolve([]) }) }) }),
}));

const { getAtRiskStudentsAdmin } = require("../services/alerts/atRiskAlerts.service");
const { isBeyondMarkingGrace, MARKING_GRACE_DAYS } = require("../services/academic/markingFollowUp.service");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CLASS_G9 = "507f1f77bcf86cd799439011";
const CLASS_G10 = "507f1f77bcf86cd799439022";

function student(id, name, classId, className, gradeLevel) {
  return {
    _id: id,
    name,
    studentId: `STU-${id}`,
    rollNumber: id,
    classLevel: { _id: classId, name: className, gradeLevel, toString: () => classId },
    toString: () => id,
  };
}

function setupStudents(students) {
  mockStudentFind.mockImplementation((query) => {
    let out = students;
    // Honour the grade-tab filter the service builds: classLevel: { $in: [...] }
    if (query && query.classLevel && query.classLevel.$in) {
      const ids = query.classLevel.$in.map(String);
      out = out.filter((s) => ids.includes(String(s.classLevel._id)));
    } else if (query && query.classLevel) {
      out = out.filter((s) => String(s.classLevel._id) === String(query.classLevel));
    }
    return {
      select: () => ({
        populate: () => ({
          populate: () => ({
            sort: () => ({ lean: () => Promise.resolve(out) }),
          }),
        }),
      }),
    };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAttendanceAggregate.mockResolvedValue([]);
  mockTestResultFind.mockReturnValue({
    populate: () => ({ lean: () => Promise.resolve([]) }),
  });
});

// ═────────────────────────────────────────────────────────────────────────────
describe("getAtRiskStudentsAdmin — gradeLevel filter (At-Risk grade tabs)", () => {
  const g9Low = student("s9", "Grade Nine Low", CLASS_G9, "Class 9", "9");
  const g10Low = student("s10", "Grade Ten Low", CLASS_G10, "Class 10", "10");

  beforeEach(() => {
    setupStudents([g9Low, g10Low]);
    // Both students sit below the MARKS threshold — a 25 % Chemistry average
    // (attendance no longer flags on the admin path).
    mockAttendanceAggregate.mockResolvedValue([
      { _id: { toString: () => "s9" }, present: 0, absent: 10, late: 0 },
      { _id: { toString: () => "s10" }, present: 0, absent: 10, late: 0 },
    ]);
    mockTestResultFind.mockReturnValue({
      populate: () => ({
        lean: () =>
          Promise.resolve([
            { student: { toString: () => "s9" }, test: { subject: { name: "Chemistry" }, totalMarks: 100 }, score: 25 },
            { student: { toString: () => "s10" }, test: { subject: { name: "Chemistry" }, totalMarks: 100 }, score: 25 },
          ]),
      }),
    });
  });

  test("without gradeLevel both grades are flagged (school-wide default unchanged)", async () => {
    const result = await getAtRiskStudentsAdmin(undefined, "");
    expect(mockClassFindForGrade).not.toHaveBeenCalled();
    expect(result.students.map((r) => r.student.name).sort()).toEqual(["Grade Nine Low", "Grade Ten Low"]);
    expect(result.total).toBe(2);
  });

  test("gradeLevel restricts the population to that grade's classes", async () => {
    mockClassFindForGrade.mockResolvedValue([{ _id: CLASS_G9 }]);
    const result = await getAtRiskStudentsAdmin(undefined, "", "9");
    expect(mockClassFindForGrade).toHaveBeenCalledWith({ gradeLevel: "9" });
    expect(result.students.map((r) => r.student.name)).toEqual(["Grade Nine Low"]);
    expect(result.total).toBe(1);
  });

  test("grade with no matching classes flags nobody", async () => {
    mockClassFindForGrade.mockResolvedValue([]);
    const result = await getAtRiskStudentsAdmin(undefined, "", "12");
    expect(result.students).toEqual([]);
    expect(result.total).toBe(0);
  });

  test("class filter + grade combine: a class outside the grade yields nothing", async () => {
    mockClassFindForGrade.mockResolvedValue([{ _id: CLASS_G9 }]);
    const result = await getAtRiskStudentsAdmin(CLASS_G10, "", "9");
    expect(result.students).toEqual([]);
  });

  test("class filter + grade combine: a class inside the grade still flags its students", async () => {
    mockClassFindForGrade.mockResolvedValue([{ _id: CLASS_G9 }, { _id: CLASS_G10 }]);
    const result = await getAtRiskStudentsAdmin(CLASS_G9, "", "9");
    expect(result.students.map((r) => r.student.name)).toEqual(["Grade Nine Low"]);
  });

  test("attendance alone never flags — bad attendance with passing marks is not listed", async () => {
    // Same 0 % attendance fixtures, but every score now passes the 40 % bar.
    mockTestResultFind.mockReturnValue({
      populate: () => ({
        lean: () =>
          Promise.resolve([
            { student: { toString: () => "s9" }, test: { subject: { name: "Chemistry" }, totalMarks: 100 }, score: 80 },
            { student: { toString: () => "s10" }, test: { subject: { name: "Chemistry" }, totalMarks: 100 }, score: 80 },
          ]),
      }),
    });
    const result = await getAtRiskStudentsAdmin(undefined, "");
    expect(result.students).toEqual([]);
    expect(result.total).toBe(0);
  });

  test("flags still follow the confirmed criteria (subject avg < 40%; attendance display-only)", async () => {
    mockClassFindForGrade.mockResolvedValue([{ _id: CLASS_G9 }]);
    mockAttendanceAggregate.mockResolvedValue([
      { _id: { toString: () => "s9" }, present: 9, absent: 1, late: 0 }, // 90% — above threshold
      { _id: { toString: () => "s10" }, present: 9, absent: 1, late: 0 },
    ]);
    mockTestResultFind.mockReturnValue({
      populate: () => ({
        lean: () =>
          Promise.resolve([
            {
              student: { toString: () => "s9" },
              test: { subject: { name: "Chemistry" }, totalMarks: 100 },
              score: 25, // 25% avg — below the 40% score threshold
            },
          ]),
      }),
    });
    const result = await getAtRiskStudentsAdmin(undefined, "", "9");
    expect(result.students).toHaveLength(1);
    expect(result.students[0].reasons).toEqual([
      { type: "score", message: "25% avg in Chemistry", value: 25, subject: "Chemistry" },
    ]);
    // attendancePercent is exposed for the Att % column even though 90 %
    // attendance itself contributes no flag; averagePercent/tests drive the
    // Top-Performers-style row.
    expect(result.students[0].attendancePercent).toBe(90);
    expect(result.students[0].averagePercent).toBe(25);
    expect(result.students[0].tests).toBe(1);
  });

  test("each row carries student.gradeLevel so the route can bucket grade tabs", async () => {
    const result = await getAtRiskStudentsAdmin(undefined, "");
    const byName = Object.fromEntries(result.students.map((r) => [r.student.name, r.student.gradeLevel]));
    expect(byName).toEqual({ "Grade Nine Low": "9", "Grade Ten Low": "10" });
  });

  test("options.maxList = null returns the FULL ranked list; default still caps at 10", async () => {
    // 12 failing students, each with one 25 % Chemistry result.
    const many = Array.from({ length: 12 }, (_, i) =>
      student("m" + i, "Low " + String(i).padStart(2, "0"), CLASS_G9, "Class 9", "9")
    );
    setupStudents(many);
    mockAttendanceAggregate.mockResolvedValue([]);
    mockTestResultFind.mockReturnValue({
      populate: () => ({
        lean: () =>
          Promise.resolve(
            many.map((s) => ({
              student: { toString: () => s._id },
              test: { subject: { name: "Chemistry" }, totalMarks: 100 },
              score: 25,
            }))
          ),
      }),
    });
    const capped = await getAtRiskStudentsAdmin(undefined, "");
    expect(capped.students).toHaveLength(10);
    expect(capped.total).toBe(12);
    expect(capped.hasMore).toBe(true);
    const full = await getAtRiskStudentsAdmin(undefined, "", undefined, { maxList: null });
    expect(full.students).toHaveLength(12);
    expect(full.total).toBe(12);
  });
});

// ═────────────────────────────────────────────────────────────────────────────
describe("isBeyondMarkingGrace — 3-day dashboard grace window", () => {
  const NOW = new Date("2026-10-16T12:00:00Z");

  test("grace window is 3 days", () => {
    expect(MARKING_GRACE_DAYS).toBe(3);
  });

  test("tests held 1–3 days ago are still inside the grace window", () => {
    expect(isBeyondMarkingGrace(new Date("2026-10-15T12:00:00Z"), NOW)).toBe(false);
    expect(isBeyondMarkingGrace(new Date("2026-10-14T12:00:00Z"), NOW)).toBe(false);
    expect(isBeyondMarkingGrace(new Date("2026-10-13T12:00:00Z"), NOW)).toBe(false); // exactly 3 days
  });

  test("a test held 4+ days ago is beyond the grace window", () => {
    expect(isBeyondMarkingGrace(new Date("2026-10-12T12:00:00Z"), NOW)).toBe(true);
    expect(isBeyondMarkingGrace(new Date("2026-10-01T12:00:00Z"), NOW)).toBe(true);
  });
});
