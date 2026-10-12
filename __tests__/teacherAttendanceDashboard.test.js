/**
 * Tests for the teacher-scoped attendance dashboard.
 *
 * The teacher endpoint reuses getAttendanceDashboardService with a
 * `classLevels` array (the teacher's Assignment-derived classes):
 *   • every aggregation — attendance totals, class×day breakdown, enrolled
 *     head-counts, class docs — is restricted to that set,
 *   • an empty assignment set fails CLOSED (zeroed payload, no queries run),
 *   • the controller validates any client-supplied classLevel against the
 *     assignment set and answers 403 — query-param manipulation can never
 *     widen a teacher's scope to another teacher's class.
 *
 * The admin/manager path (no classLevels arg) is covered by
 * attendanceDashboard.test.js and must stay byte-identical in behaviour.
 */

const mockAttendanceAggregate = jest.fn();
const mockStudentAggregate = jest.fn();
const mockClassLevelFind = jest.fn();
const mockAssignmentDistinct = jest.fn();

jest.mock("../models/Academic/attendance.model", () => ({
  aggregate: (...a) => mockAttendanceAggregate(...a),
}));
jest.mock("../models/Students/students.model", () => ({
  aggregate: (...a) => mockStudentAggregate(...a),
}));
jest.mock("../models/Academic/class.model", () => ({
  find: (...a) => mockClassLevelFind(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  distinct: (...a) => mockAssignmentDistinct(...a),
}));

const mongoose = require("mongoose");
const { getAttendanceDashboardService } = require("../services/academic/attendance.service");
const { getTeacherAttendanceDashboardController } = require("../controllers/academic/attendance.controller");

const CLASS_A = new mongoose.Types.ObjectId(); // teacher's class
const CLASS_B = new mongoose.Types.ObjectId(); // teacher's other class
const CLASS_OTHER = new mongoose.Types.ObjectId(); // another teacher's class
const TEACHER_ID = new mongoose.Types.ObjectId();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function payload(res) {
  return res.json.mock.calls[0][0];
}

function setupAttendanceAggregates({ dayAgg = [], classDayAgg = [] }) {
  mockAttendanceAggregate.mockImplementation((pipeline) => {
    const groupId = pipeline[1] && pipeline[1].$group && pipeline[1].$group._id;
    if (groupId && typeof groupId === "object" && groupId.classLevel) {
      return Promise.resolve(classDayAgg);
    }
    return Promise.resolve(dayAgg);
  });
}

function setupEnrolled(countsByClass) {
  mockStudentAggregate.mockResolvedValue(
    Object.entries(countsByClass).map(([id, n]) => ({ _id: new mongoose.Types.ObjectId(id), n }))
  );
}

function setupClassDocs(docs) {
  const chain = { sort: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(docs) };
  mockClassLevelFind.mockReturnValue(chain);
}

beforeEach(() => jest.clearAllMocks());

// ── Service level: classLevels scoping ──────────────────────────────────────

describe("getAttendanceDashboardService — teacher classLevels scope", () => {
  it("restricts every aggregation to the assigned classes and totals only those", async () => {
    setupAttendanceAggregates({
      dayAgg: [
        { _id: "2026-10-06", present: 9, absent: 1, late: 0, marked: 10 },
        { _id: "2026-10-07", present: 8, absent: 2, late: 0, marked: 10 },
      ],
      classDayAgg: [
        { _id: { classLevel: CLASS_A, date: "2026-10-06" }, present: 9, absent: 1, late: 0, marked: 10 },
        { _id: { classLevel: CLASS_A, date: "2026-10-07" }, present: 8, absent: 2, late: 0, marked: 10 },
      ],
    });
    setupEnrolled({ [CLASS_A.toString()]: 10 });
    setupClassDocs([{ _id: CLASS_A, name: "Class A" }]);

    const res = mockRes();
    await getAttendanceDashboardService("2026-10-06", "2026-10-07", "", true, res, [CLASS_A]);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = payload(res).data;

    // Totals cover only the teacher's class
    expect(data.summary).toMatchObject({ present: 17, absent: 3, late: 0, marked: 20 });
    expect(data.enrolled).toBe(10);
    expect(data.enrolledTotal).toBe(10); // teacher scope: total = assigned classes only
    expect(data.classes).toHaveLength(1);
    expect(data.classes[0].name).toBe("Class A");
    expect(data.classes[0].incomplete).toBe(false); // 20 = 10 enrolled × 2 marked days

    // Daily pipeline class-filtered with $in
    const dayPipeline = mockAttendanceAggregate.mock.calls[0][0];
    expect(dayPipeline[0].$match.classLevel).toEqual(CLASS_A); // single id → equality

    // Student head-count query is class-scoped too
    const studentPipeline = mockStudentAggregate.mock.calls[0][0];
    expect(studentPipeline[0].$match.classLevel).toEqual({ $in: [CLASS_A] });

    // Class docs fetched with an _id $in filter, not the whole institute
    expect(mockClassLevelFind.mock.calls[0][0]).toEqual({ _id: { $in: [CLASS_A] } });
  });

  it("multi-class scope uses $in and flags only the teacher's own classes", async () => {
    setupAttendanceAggregates({
      dayAgg: [{ _id: "2026-10-06", present: 14, absent: 6, late: 0, marked: 20 }],
      classDayAgg: [
        { _id: { classLevel: CLASS_A, date: "2026-10-06" }, present: 10, absent: 0, late: 0, marked: 10 },
        { _id: { classLevel: CLASS_B, date: "2026-10-06" }, present: 4, absent: 6, late: 0, marked: 10 },
      ],
    });
    setupEnrolled({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10 });
    setupClassDocs([
      { _id: CLASS_A, name: "Class A" },
      { _id: CLASS_B, name: "Class B" },
    ]);

    const res = mockRes();
    await getAttendanceDashboardService("2026-10-06", "2026-10-06", "", true, res, [CLASS_A, CLASS_B]);

    const data = payload(res).data;
    expect(data.enrolled).toBe(20);
    expect(data.classes.map((c) => c.name)).toEqual(["Class A", "Class B"]);
    expect(data.classes.find((c) => c.name === "Class A").incomplete).toBe(false);
    expect(data.classes.find((c) => c.name === "Class B").incomplete).toBe(false);

    const dayPipeline = mockAttendanceAggregate.mock.calls[0][0];
    expect(dayPipeline[0].$match.classLevel).toEqual({ $in: [CLASS_A, CLASS_B] });

    // The class×day breakdown runs class-scoped as well
    const breakdownPipeline = mockAttendanceAggregate.mock.calls[1][0];
    expect(breakdownPipeline[0].$match.classLevel).toEqual({ $in: [CLASS_A, CLASS_B] });
  });

  it("empty assignment list fails CLOSED: zeroed payload, no aggregates run", async () => {
    const res = mockRes();
    await getAttendanceDashboardService("2026-10-06", "2026-10-07", "", true, res, []);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = payload(res).data;
    expect(data.enrolled).toBe(0);
    expect(data.summary).toMatchObject({ present: 0, absent: 0, late: 0, marked: 0, rate: null });
    expect(data.days).toEqual([]);
    expect(data.classes).toEqual([]);
    // Nothing that could leak institute-wide data executed
    expect(mockAttendanceAggregate).not.toHaveBeenCalled();
    expect(mockStudentAggregate).not.toHaveBeenCalled();
    expect(mockClassLevelFind).not.toHaveBeenCalled();
  });

  it("breakdown=0 in teacher scope skips the class×day aggregation", async () => {
    setupAttendanceAggregates({
      dayAgg: [{ _id: "2026-10-06", present: 10, absent: 0, late: 0, marked: 10 }],
    });
    setupEnrolled({});
    setupClassDocs([]);

    const res = mockRes();
    await getAttendanceDashboardService("2026-10-01", "2026-10-31", "", false, res, [CLASS_A]);

    expect(mockAttendanceAggregate).toHaveBeenCalledTimes(1);
    expect(payload(res).data.classes).toEqual([]);
  });
});

// ── Controller level: query-param manipulation must be refused ─────────────

function mockReq(query) {
  return { query, userAuth: { id: TEACHER_ID } };
}

describe("getTeacherAttendanceDashboardController — access control", () => {
  it("403s a classLevel the teacher is not assigned to (other teacher's class id)", async () => {
    mockAssignmentDistinct.mockResolvedValue([CLASS_A]);
    setupAttendanceAggregates({});

    const res = mockRes();
    await getTeacherAttendanceDashboardController(
      mockReq({ startDate: "2026-10-06", endDate: "2026-10-06", classLevel: CLASS_OTHER.toString() }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payload(res)).toMatchObject({ status: "failed", message: /not assigned/i });
    // The refusal happens BEFORE any dashboard aggregation runs
    expect(mockAttendanceAggregate).not.toHaveBeenCalled();
  });

  it("403s a malformed classLevel instead of silently serving the full scope", async () => {
    mockAssignmentDistinct.mockResolvedValue([CLASS_A]);

    const res = mockRes();
    await getTeacherAttendanceDashboardController(
      mockReq({ startDate: "2026-10-06", endDate: "2026-10-06", classLevel: "garbage" }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockAttendanceAggregate).not.toHaveBeenCalled();
  });

  it("scopes to all assigned classes when no classLevel is passed", async () => {
    mockAssignmentDistinct.mockResolvedValue([CLASS_A, CLASS_B]);
    setupAttendanceAggregates({
      dayAgg: [{ _id: "2026-10-06", present: 10, absent: 0, late: 0, marked: 10 }],
      classDayAgg: [],
    });
    setupEnrolled({ [CLASS_A.toString()]: 10 });
    setupClassDocs([{ _id: CLASS_A, name: "Class A" }, { _id: CLASS_B, name: "Class B" }]);

    const res = mockRes();
    await getTeacherAttendanceDashboardController(
      mockReq({ startDate: "2026-10-06", endDate: "2026-10-06" }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const dayPipeline = mockAttendanceAggregate.mock.calls[0][0];
    expect(dayPipeline[0].$match.classLevel).toEqual({ $in: [CLASS_A, CLASS_B] });
  });

  it("assigned class param narrows to that class and skips the class breakdown", async () => {
    mockAssignmentDistinct.mockResolvedValue([CLASS_A, CLASS_B]);
    setupAttendanceAggregates({
      dayAgg: [{ _id: "2026-10-06", present: 10, absent: 0, late: 0, marked: 10 }],
    });
    setupEnrolled({ [CLASS_A.toString()]: 10 });
    setupClassDocs([]);

    const res = mockRes();
    await getTeacherAttendanceDashboardController(
      mockReq({ startDate: "2026-10-06", endDate: "2026-10-06", classLevel: CLASS_A.toString() }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const dayPipeline = mockAttendanceAggregate.mock.calls[0][0];
    expect(dayPipeline[0].$match.classLevel).toEqual(CLASS_A);
    // single-class scope: no class×day breakdown (mirrors admin class scope)
    expect(mockAttendanceAggregate).toHaveBeenCalledTimes(1);
  });

  it("teacher with zero assignments gets the empty fail-closed payload", async () => {
    mockAssignmentDistinct.mockResolvedValue([]);

    const res = mockRes();
    await getTeacherAttendanceDashboardController(
      mockReq({ startDate: "2026-10-06", endDate: "2026-10-06" }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data.enrolled).toBe(0);
    expect(mockAttendanceAggregate).not.toHaveBeenCalled();
  });
});
