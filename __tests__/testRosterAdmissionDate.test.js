/**
 * A pupil admitted to a class AFTER a test was held was not in that class when
 * the test happened, so they must not be pulled into its marks:
 *
 *   • the mark-entry roster (getTestRosterService) omits them;
 *   • the write path (submitTestResultsService) refuses a score for them and
 *     writes nothing — hiding the row isn't enough, the API must enforce it;
 *   • a pupil admitted on the test's own day (or earlier), and one with no
 *     recorded admission date, stay visible;
 *   • the marks audit no longer counts a late admission towards a test's
 *     expected roster, so an old test is not stuck "unmarked" forever.
 *
 * Models are mocked at the data layer; the real service filtering executes.
 */

const mockTestFindById = jest.fn();
const mockTestFind = jest.fn();
const mockStudentFind = jest.fn();
const mockResultFind = jest.fn();
const mockResultFindOneAndUpdate = jest.fn();
const mockAssignmentFind = jest.fn();
const mockTeacherFind = jest.fn();
const mockSessionFind = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  find: (...a) => mockTestFind(...a),
  findById: (...a) => mockTestFindById(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockResultFind(...a),
  findOneAndUpdate: (...a) => mockResultFindOneAndUpdate(...a),
}));
jest.mock("../models/Academic/testSession.model", () => ({
  find: (...a) => mockSessionFind(...a),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  find: (...a) => mockTeacherFind(...a),
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
  getMarksAuditService,
} = require("../services/academic/test.service");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SUBJECT = "sub-math";
const CLASS = "cls-5";
const TEACHER = "teacher-1";

const TEST_DATE = new Date("2026-09-10T09:00:00Z");
const TEST = {
  _id: "test-1",
  subject: SUBJECT,
  classLevels: [CLASS],
  totalMarks: 100,
  date: TEST_DATE,
};

// admittedBefore (Jan) and admittedOnTestDay (the test's own instant) both
// belong to the test; admittedLater (09-15) does not; noAdmissionDate has no
// date recorded.
const STUDENTS = [
  { _id: "admittedBefore", name: "Before", studentId: "S1", classLevel: CLASS, dateAdmitted: new Date("2026-01-01T00:00:00Z") },
  { _id: "admittedOnTestDay", name: "OnDay", studentId: "S2", classLevel: CLASS, dateAdmitted: new Date(TEST_DATE) },
  { _id: "admittedLater", name: "Later", studentId: "S3", classLevel: CLASS, dateAdmitted: new Date("2026-09-15T00:00:00Z") },
  { _id: "noAdmissionDate", name: "NoDate", studentId: "S4", classLevel: CLASS, dateAdmitted: null },
];

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// Apply the query operators the roster / write-path service relies on so the
// real filtering runs against the fixture list.
function filterStudents(q) {
  let out = STUDENTS.slice();
  if (q.classLevel && q.classLevel.$in) {
    const cls = q.classLevel.$in.map(String);
    out = out.filter((s) => cls.includes(String(s.classLevel)));
  }
  if (q._id && q._id.$in) {
    const ids = q._id.$in.map(String);
    out = out.filter((s) => ids.includes(String(s._id)));
  }
  // dateAdmitted: { $not: { $gt: cutoff } }  →  drop strictly-later admissions,
  // keep null / missing dates.
  if (q.dateAdmitted && q.dateAdmitted.$not && q.dateAdmitted.$not.$gt !== undefined) {
    const cutoff = new Date(q.dateAdmitted.$not.$gt);
    out = out.filter((s) => !s.dateAdmitted || new Date(s.dateAdmitted) <= cutoff);
  }
  // dateAdmitted: { $gt: cutoff }  →  keep ONLY strictly-later admissions
  // (the write path's "admitted too late" probe).
  if (q.dateAdmitted && q.dateAdmitted.$gt !== undefined && !q.dateAdmitted.$not) {
    const cutoff = new Date(q.dateAdmitted.$gt);
    out = out.filter((s) => s.dateAdmitted && new Date(s.dateAdmitted) > cutoff);
  }
  return out;
}

// A query stub that behaves like a real Mongoose chain: every link (select /
// populate / sort) returns itself, and it resolves both when awaited directly
// (`.then`) and through `.lean()` — so the same helper serves the roster path
// (find().select().populate()) and the audit path (find().select().lean()).
function chainResolve(docs) {
  const chain = {
    select: () => chain,
    populate: () => chain,
    sort: () => chain,
    lean: () => Promise.resolve(docs),
    then: (resolve, reject) => Promise.resolve(docs).then(resolve, reject),
  };
  return chain;
}

const ASSIGN_DOCS = [{ teacher: TEACHER, subject: SUBJECT, classLevel: CLASS }];

beforeEach(() => {
  jest.clearAllMocks();

  mockTestFindById.mockImplementation(() => chainResolve(TEST));
  mockTestFind.mockImplementation(() => chainResolve([TEST]));

  mockAssignmentFind.mockImplementation((q) => {
    let docs = ASSIGN_DOCS;
    if (q && q.classLevel && q.classLevel.$in) {
      const ids = q.classLevel.$in.map(String);
      docs = ASSIGN_DOCS.filter(
        (a) =>
          String(a.teacher) === String(q.teacher) &&
          String(a.subject) === String(q.subject) &&
          ids.includes(String(a.classLevel))
      );
    }
    // getAssignedClassLevels maps `.classLevel` off the awaited docs; the audit
    // reads teacher/subject/classLevel off the lean docs — both shapes work.
    return chainResolve(docs);
  });

  mockStudentFind.mockImplementation((q) => chainResolve(filterStudents(q)));

  mockResultFind.mockImplementation(() => chainResolve([]));
  mockResultFindOneAndUpdate.mockImplementation(async (_q, doc) => doc);
  mockSessionFind.mockImplementation(() => chainResolve([]));
  mockTeacherFind.mockImplementation(() => chainResolve([]));
});

// ── Roster ───────────────────────────────────────────────────────────────────
describe("getTestRosterService — omits pupils admitted after the test date", () => {
  test("roster lists only students who were in the class by the test day", async () => {
    const res = mockRes();
    await getTestRosterService("test-1", TEACHER, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const ids = res.json.mock.calls[0][0].data.roster.map((r) => String(r.student)).sort();
    expect(ids).toEqual(["admittedBefore", "admittedOnTestDay", "noAdmissionDate"]);
    expect(ids).not.toContain("admittedLater");
  });
});

// ── Write path ───────────────────────────────────────────────────────────────
describe("submitTestResultsService — refuses a score for a late admission", () => {
  test("scores for students in the class by the test day are saved", async () => {
    const res = mockRes();
    await submitTestResultsService(
      "test-1",
      [{ student: "admittedBefore", score: 80 }, { student: "admittedOnTestDay", score: 75 }],
      TEACHER,
      res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockResultFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  test("a batch containing a pupil admitted after the test is rejected and writes nothing", async () => {
    const res = mockRes();
    await submitTestResultsService(
      "test-1",
      [{ student: "admittedBefore", score: 50 }, { student: "admittedLater", score: 90 }],
      TEACHER,
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].message).toMatch(/admitted after this test's date/i);
    expect(mockResultFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

// ── Marks audit ──────────────────────────────────────────────────────────────
describe("getMarksAuditService — a late admission never keeps an old test unmarked", () => {
  test("expected count excludes a pupil admitted after the test's date", async () => {
    // The audit loads the active roster via find().select().lean(); give it the
    // three in-class pupils plus the late one. All but "Later" have a score.
    mockStudentFind.mockImplementation(() =>
      chainResolve([
        { classLevel: CLASS, dateAdmitted: new Date("2026-01-01T00:00:00Z"), _id: "admittedBefore" },
        { classLevel: CLASS, dateAdmitted: new Date(TEST_DATE), _id: "admittedOnTestDay" },
        { classLevel: CLASS, dateAdmitted: null, _id: "noAdmissionDate" },
        { classLevel: CLASS, dateAdmitted: new Date("2026-09-15T00:00:00Z"), _id: "admittedLater" },
      ])
    );
    mockResultFind.mockImplementation(() =>
      chainResolve([
        { test: "test-1", student: "admittedBefore", score: 10, markedBy: null, createdAt: TEST_DATE, updatedAt: TEST_DATE },
        { test: "test-1", student: "admittedOnTestDay", score: 20, markedBy: null, createdAt: TEST_DATE, updatedAt: TEST_DATE },
        { test: "test-1", student: "noAdmissionDate", score: 30, markedBy: null, createdAt: TEST_DATE, updatedAt: TEST_DATE },
      ])
    );

    const res = mockRes();
    await getMarksAuditService({ limit: "all" }, res);
    const row = res.json.mock.calls[0][0].data.rows.find((r) => r.testId === "test-1");

    // Expected is 3 (the late admission is dropped) and all 3 are marked.
    expect(row.expectedCount).toBe(3);
    expect(row.fullyMarked).toBe(true);
    expect(row.status).toBe("marked");
  });
});
