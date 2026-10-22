/**
 * A pupil who is no longer enrolled (status "inactive", or graduated, or
 * withdrawn) must never be offered for marking, anywhere marks are entered:
 *
 *   • the mark-entry roster (getTestRosterService) omits them — this same
 *     endpoint also feeds the OCR candidate pool, so OCR is covered transitively;
 *   • the write path (submitTestResultsService) refuses a score for them and
 *     writes NOTHING — hiding the row isn't enough, a direct API POST must be
 *     rejected too (fail-closed, mirroring the late-admission guard);
 *   • an active pupil in the same class is still listed and still saves.
 *
 * Historical data is out of scope here: TestResult rows already recorded before
 * a pupil went inactive stay in the DB and keep showing in reports. This suite
 * only proves the mark-ENTRY surfaces exclude them.
 *
 * Models are mocked at the data layer; the real service filtering executes.
 */

const mockTestFindById = jest.fn();
const mockStudentFind = jest.fn();
const mockResultFind = jest.fn();
const mockResultFindOneAndUpdate = jest.fn();
const mockResultBulkWrite = jest.fn();
const mockAssignmentFind = jest.fn();
const mockTeacherFind = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  find: () => mockChainResolve([]),
  findById: (...a) => mockTestFindById(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockResultFind(...a),
  findOneAndUpdate: (...a) => mockResultFindOneAndUpdate(...a),
  bulkWrite: (...a) => mockResultBulkWrite(...a),
}));
jest.mock("../models/Academic/testSession.model", () => ({ find: () => mockChainResolve([]) }));
jest.mock("../models/Staff/teachers.model", () => ({ find: (...a) => mockTeacherFind(...a) }));
jest.mock("../models/Students/students.model", () => ({ find: (...a) => mockStudentFind(...a) }));
jest.mock("../models/Academic/assignment.model", () => ({ find: (...a) => mockAssignmentFind(...a) }));

const { getTestRosterService, submitTestResultsService } = require("../services/academic/test.service");

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

// All four sit in the same class and were admitted before the test, so the ONLY
// thing that separates them is enrolment status.
const STUDENTS = [
  { _id: "active", name: "Active Kid", classLevel: CLASS, dateAdmitted: new Date("2026-01-01T00:00:00Z"), status: "active" },
  { _id: "inactive", name: "Inactive Kid", classLevel: CLASS, dateAdmitted: new Date("2026-01-01T00:00:00Z"), status: "inactive" },
  { _id: "graduated", name: "Graduated Kid", classLevel: CLASS, dateAdmitted: new Date("2026-01-01T00:00:00Z"), status: "active", isGraduated: true },
  { _id: "withdrawn", name: "Withdrawn Kid", classLevel: CLASS, dateAdmitted: new Date("2026-01-01T00:00:00Z"), status: "active", isWithdrawn: true },
];

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// Apply every query operator the roster / write-path services rely on so the
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
  // status / isGraduated / isWithdrawn with $ne (the active-student triple).
  if (q.status && q.status.$ne !== undefined) out = out.filter((s) => s.status !== q.status.$ne);
  if (q.isGraduated && q.isGraduated.$ne !== undefined) out = out.filter((s) => s.isGraduated !== q.isGraduated.$ne);
  if (q.isWithdrawn && q.isWithdrawn.$ne !== undefined) out = out.filter((s) => s.isWithdrawn !== q.isWithdrawn.$ne);
  // dateAdmitted: { $not: { $gt: cutoff } } → drop strictly-later admissions.
  if (q.dateAdmitted && q.dateAdmitted.$not && q.dateAdmitted.$not.$gt !== undefined) {
    const cutoff = new Date(q.dateAdmitted.$not.$gt);
    out = out.filter((s) => !s.dateAdmitted || new Date(s.dateAdmitted) <= cutoff);
  }
  // dateAdmitted: { $gt: cutoff } → keep ONLY strictly-later (late probe).
  if (q.dateAdmitted && q.dateAdmitted.$gt !== undefined && !q.dateAdmitted.$not) {
    const cutoff = new Date(q.dateAdmitted.$gt);
    out = out.filter((s) => s.dateAdmitted && new Date(s.dateAdmitted) > cutoff);
  }
  // $or [...] (the write path's "no longer enrolled" probe): keep only rows
  // matching at least one of the equality clauses.
  if (Array.isArray(q.$or)) {
    out = out.filter((s) =>
      q.$or.some((cond) => Object.keys(cond).every((k) => String(s[k]) === String(cond[k])))
    );
  }
  return out;
}

function mockChainResolve(docs) {
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

  mockTestFindById.mockImplementation(() => mockChainResolve(TEST));
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
    return mockChainResolve(docs);
  });
  mockStudentFind.mockImplementation((q) => mockChainResolve(filterStudents(q)));
  mockResultFind.mockImplementation(() => mockChainResolve([]));
  mockResultFindOneAndUpdate.mockImplementation(async (_q, doc) => doc);
  mockResultBulkWrite.mockResolvedValue({ upsertedCount: 0, modifiedCount: 0, matchedCount: 0 });
  mockTeacherFind.mockImplementation(() => mockChainResolve([]));
});

// ── Roster ───────────────────────────────────────────────────────────────────
describe("getTestRosterService — omits no-longer-enrolled pupils", () => {
  test("roster lists only the active pupil of the class", async () => {
    const res = mockRes();
    await getTestRosterService("test-1", TEACHER, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const ids = res.json.mock.calls[0][0].data.roster.map((r) => String(r.student));
    expect(ids).toEqual(["active"]);
    expect(ids).not.toContain("inactive");
    expect(ids).not.toContain("graduated");
    expect(ids).not.toContain("withdrawn");
  });

  test("sends the active-student triple to the DB", async () => {
    const res = mockRes();
    await getTestRosterService("test-1", TEACHER, res);

    const rosterQuery = mockStudentFind.mock.calls[0][0];
    expect(rosterQuery).toMatchObject({
      classLevel: { $in: [CLASS] },
      status: { $ne: "inactive" },
      isGraduated: { $ne: true },
      isWithdrawn: { $ne: true },
    });
  });
});

// ── Write path ───────────────────────────────────────────────────────────────
describe("submitTestResultsService — refuses a score for a no-longer-enrolled pupil", () => {
  test("a score for the active pupil is saved", async () => {
    const res = mockRes();
    await submitTestResultsService("test-1", [{ student: "active", score: 80 }], TEACHER, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockResultBulkWrite).toHaveBeenCalledTimes(1);
    expect(mockResultBulkWrite.mock.calls[0][0]).toHaveLength(1);
  });

  test("a batch containing an inactive pupil is rejected and writes nothing", async () => {
    const res = mockRes();
    await submitTestResultsService(
      "test-1",
      [{ student: "active", score: 50 }, { student: "inactive", score: 90 }],
      TEACHER,
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].message).toMatch(/no longer enrolled/i);
    expect(mockResultBulkWrite).not.toHaveBeenCalled();
  });

  test("a graduated or withdrawn pupil in the batch is rejected too", async () => {
    for (const bad of ["graduated", "withdrawn"]) {
      mockResultBulkWrite.mockClear();
      const res = mockRes();
      await submitTestResultsService("test-1", [{ student: bad, score: 40 }], TEACHER, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockResultBulkWrite).not.toHaveBeenCalled();
    }
  });
});
