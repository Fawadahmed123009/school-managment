/**
 * A pupil whose status is "inactive" must never be considered in attendance:
 *
 *   • the marking roster (getClassRosterForDateService) omits them, so the UI
 *     never offers them for a present/absent/late mark;
 *   • the write path (markClassAttendanceService) refuses a batch that names an
 *     inactive (or foreign) pupil and writes NOTHING — hiding the row in the
 *     roster isn't enough, a direct API POST must be rejected too (fail-closed,
 *     mirroring the test-results inactive guard);
 *   • an active pupil in the same class is still listed and still saves;
 *   • the teacher per-student list and the student-history search drop them too.
 *
 * Models are mocked at the data layer; the real service filtering executes.
 */

const STUDENTS = [
  { _id: "active", name: "Active Kid", studentId: "STU-1", rollNumber: "1", classLevel: "cls-1", status: "active" },
  { _id: "inactive", name: "Inactive Kid", studentId: "STU-2", rollNumber: "2", classLevel: "cls-1", status: "inactive" },
];

// Simulate the DB: honour a `{ status: { $ne: "inactive" } }` condition on find().
function studentsMatching(query) {
  return STUDENTS.filter((s) => {
    if (query && query.status && query.status.$ne !== undefined) return s.status !== query.status.$ne;
    return true;
  });
}

// A query chain that resolves (thenable) AND exposes .lean(), so both
// `await Model.find(...).select(...).populate(...)` and `...lean()` work.
function makeChain(rows) {
  const chain = {
    select: () => chain,
    populate: () => chain,
    sort: () => chain,
    collation: () => chain,
    lean: () => Promise.resolve(rows),
  };
  chain.then = (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected);
  return chain;
}

const mockStudentFind = jest.fn();
const mockAttendanceFind = jest.fn();
const mockAttendanceFindOneAndUpdate = jest.fn();

jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
}));
jest.mock("../models/Academic/attendance.model", () => ({
  find: (...a) => mockAttendanceFind(...a),
  findOneAndUpdate: (...a) => mockAttendanceFindOneAndUpdate(...a),
}));

const {
  getClassRosterForDateService,
  markClassAttendanceService,
  getStudentAttendanceHistoryService,
} = require("../services/academic/attendance.service");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStudentFind.mockImplementation((query) => makeChain(studentsMatching(query || {})));
  mockAttendanceFind.mockImplementation(() => makeChain([]));
});

// ── Marking roster ────────────────────────────────────────────────────────────
describe("getClassRosterForDateService — omits inactive pupils", () => {
  test("the roster lists only active students and queries with a status filter", async () => {
    const res = mockRes();
    await getClassRosterForDateService("cls-1", "2026-09-10", res);

    const roster = res.json.mock.calls[0][0].data;
    const ids = roster.map((r) => String(r.student));
    expect(ids).toContain("active");
    expect(ids).not.toContain("inactive");

    // The filter is pushed to the DB, not applied in memory.
    const query = mockStudentFind.mock.calls[0][0];
    expect(query.status).toEqual({ $ne: "inactive" });
  });
});

// ── Write-path guard (fail-closed) ─────────────────────────────────────────────
describe("markClassAttendanceService — refuses inactive pupils", () => {
  test("a batch naming an inactive student is rejected 403 and writes nothing", async () => {
    mockAttendanceFindOneAndUpdate.mockResolvedValue({});
    const res = mockRes();

    await markClassAttendanceService("cls-1", "2026-09-10", [
      { student: "active", status: "present" },
      { student: "inactive", status: "absent" },
    ], "teacher-1", res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].status).toBe("failed");
    expect(mockAttendanceFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test("an all-active batch still saves every record", async () => {
    mockAttendanceFindOneAndUpdate.mockResolvedValue({ _id: "x" });
    const res = mockRes();

    await markClassAttendanceService("cls-1", "2026-09-10", [
      { student: "active", status: "present" },
    ], "teacher-1", res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockAttendanceFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});

// ── Student-history search list ────────────────────────────────────────────────
describe("getStudentAttendanceHistoryService — search excludes inactive", () => {
  test("the returned student list is queried with a status filter", async () => {
    const res = mockRes();
    await getStudentAttendanceHistoryService({ name: "Kid" }, null, null, null, res);

    const query = mockStudentFind.mock.calls[0][0];
    expect(query.status).toEqual({ $ne: "inactive" });
  });
});
