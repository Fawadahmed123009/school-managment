/**
 * Absence handling on the mark-entry / submission path.
 *
 * Product rule (OCR + manual, both mark-entry surfaces):
 *   • an EMPTY mark means the pupil was ABSENT — the client sends score:null;
 *   • the server stores the row as score 0 + absent:true (a genuine 0 has always
 *     meant "absent" in this system, so a typed 0 is normalised the same way);
 *   • a typed positive score is stored as a present result (absent:false);
 *   • absences are surfaced on the roster (absent flag) so the UI can render "A",
 *     and are excluded from every average by the marking/analytics services.
 *
 * Models are mocked at the data layer; the real service logic executes.
 */

const mockTestFindById = jest.fn();
const mockStudentFind = jest.fn();
const mockResultFind = jest.fn();
const mockResultFindOneAndUpdate = jest.fn();
const mockAssignmentFind = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  findById: () => {
    const p = Promise.resolve(mockTestFindById());
    p.populate = jest.fn().mockReturnThis();
    return p;
  },
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

const { submitTestResultsService, getTestRosterService } = require("../services/academic/test.service");

const SUBJECT = "sub-math";
const CLASS = "cls-boys";
const TEACHER = "teacher-boys";
const TEST = { _id: "test-1", subject: SUBJECT, classLevels: [CLASS], totalMarks: 100 };
const STUDENTS = [
  { _id: "b1", name: "Boy One", studentId: "STU-B1", rollNumber: 1, classLevel: CLASS },
  { _id: "b2", name: "Boy Two", studentId: "STU-B2", rollNumber: 2, classLevel: CLASS },
  { _id: "b3", name: "Boy Three", studentId: "STU-B3", rollNumber: 3, classLevel: CLASS },
];

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTestFindById.mockReturnValue(TEST);

  mockAssignmentFind.mockImplementation(() => ({
    select: jest.fn().mockResolvedValue([{ classLevel: CLASS }]),
  }));

  mockStudentFind.mockImplementation((q) => {
    let out = STUDENTS.slice();
    if (q && q.classLevel && q.classLevel.$in) {
      const cls = q.classLevel.$in.map(String);
      out = out.filter((s) => cls.includes(String(s.classLevel)));
    }
    if (q && q._id && q._id.$in) {
      const ids = q._id.$in.map(String);
      out = out.filter((s) => ids.includes(String(s._id)));
    }
    const chain = {
      select: () => chain,
      populate: () => chain,
      then: (resolve, reject) => Promise.resolve(out).then(resolve, reject),
    };
    return chain;
  });

  mockResultFindOneAndUpdate.mockImplementation(async (_q, doc) => doc);
});

// ── Write path ───────────────────────────────────────────────────────────────
describe("submitTestResultsService — blank / zero marks become absences", () => {
  const written = (i) => mockResultFindOneAndUpdate.mock.calls[i][1];

  test("a null (blank) mark is stored as score 0 + absent true", async () => {
    const res = mockRes();
    await submitTestResultsService("test-1", [{ student: "b1", score: null }], TEACHER, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(written(0)).toMatchObject({ student: "b1", score: 0, absent: true });
  });

  test("a typed 0 is also normalised to an absence", async () => {
    const res = mockRes();
    await submitTestResultsService("test-1", [{ student: "b1", score: 0 }], TEACHER, res);
    expect(written(0)).toMatchObject({ score: 0, absent: true });
  });

  test("a positive score is stored as present (absent false)", async () => {
    const res = mockRes();
    await submitTestResultsService("test-1", [{ student: "b1", score: 72 }], TEACHER, res);
    expect(written(0)).toMatchObject({ score: 72, absent: false });
  });

  test("a mixed batch keeps absences and real marks distinct, all written", async () => {
    const res = mockRes();
    await submitTestResultsService(
      "test-1",
      [{ student: "b1", score: null }, { student: "b2", score: 55 }, { student: "b3", score: "" }],
      TEACHER,
      res
    );
    expect(mockResultFindOneAndUpdate).toHaveBeenCalledTimes(3);
    expect(written(0)).toMatchObject({ student: "b1", score: 0, absent: true });
    expect(written(1)).toMatchObject({ student: "b2", score: 55, absent: false });
    expect(written(2)).toMatchObject({ student: "b3", score: 0, absent: true });
  });

  test("an out-of-range present score is still rejected; blanks never trip it", async () => {
    const res = mockRes();
    await submitTestResultsService("test-1", [{ student: "b1", score: 999 }, { student: "b2", score: null }], TEACHER, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockResultFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

// ── Roster surfacing ─────────────────────────────────────────────────────────
describe("getTestRosterService — exposes the absent flag per pupil", () => {
  test("a stored absence carries absent:true; a real mark carries absent:false", async () => {
    mockResultFind.mockImplementation(() => ({
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { student: "b1", score: 0, absent: true, markedBy: { name: "Ms. A" }, updatedAt: new Date("2026-09-11T08:00:00Z"), createdAt: new Date("2026-09-11T08:00:00Z") },
        { student: "b2", score: 80, absent: false, markedBy: { name: "Ms. A" }, updatedAt: new Date("2026-09-11T08:00:00Z"), createdAt: new Date("2026-09-11T08:00:00Z") },
      ]),
    }));

    const res = mockRes();
    await getTestRosterService("test-1", TEACHER, res);
    const roster = res.json.mock.calls[0][0].data.roster;

    expect(roster.find((r) => r.student === "b1")).toMatchObject({ score: 0, absent: true });
    expect(roster.find((r) => r.student === "b2")).toMatchObject({ score: 80, absent: false });
    // A pupil with no saved row is neither present nor absent — just unmarked.
    expect(roster.find((r) => r.student === "b3")).toMatchObject({ score: null, absent: false });
  });
});
