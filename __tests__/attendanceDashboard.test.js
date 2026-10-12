/**
 * Tests for the attendance dashboard aggregation service (admin/manager):
 *
 * - Rate formula is (present + late) / totalMarked everywhere.
 * - Incomplete flagging: class marked below enrolled × marked-days is flagged;
 *   a fully marked class is not; classes with zero records still appear.
 * - Class scope: enrolled is the class head-count, class breakdown is skipped.
 * - breakdown=0: the class×day aggregation never runs (monthly re-fetch).
 * - Missing dates → 400.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockAttendanceAggregate = jest.fn();
const mockStudentAggregate = jest.fn();
const mockClassLevelFind = jest.fn();

jest.mock("../models/Academic/attendance.model", () => ({
  aggregate: (...a) => mockAttendanceAggregate(...a),
}));
jest.mock("../models/Students/students.model", () => ({
  aggregate: (...a) => mockStudentAggregate(...a),
}));
jest.mock("../models/Academic/class.model", () => ({
  find: (...a) => mockClassLevelFind(...a),
}));

const mongoose = require("mongoose");
const { getAttendanceDashboardService } = require("../services/academic/attendance.service");

const CLASS_A = new mongoose.Types.ObjectId();
const CLASS_B = new mongoose.Types.ObjectId();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function payload(res) {
  return res.json.mock.calls[0][0];
}

// Route each Attendance.aggregate call by pipeline shape:
// the class×day breakdown groups by an _id OBJECT, the daily rollup by string.
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

describe("getAttendanceDashboardService", () => {
  it("computes institute totals with the (present+late)/marked rate and flags incomplete classes", async () => {
    // Two marked days; Class A has 10 enrolled and full coverage (20 records),
    // Class B has 10 enrolled but only 12 → flagged incomplete.
    setupAttendanceAggregates({
      dayAgg: [
        { _id: "2026-10-06", present: 12, absent: 3, late: 1, marked: 16 },
        { _id: "2026-10-07", present: 14, absent: 2, late: 0, marked: 16 },
      ],
      classDayAgg: [
        // Sums per day match dayAgg exactly: day1 12+3+1=16, day2 14+2+0=16
        { _id: { classLevel: CLASS_A, date: "2026-10-06" }, present: 9, absent: 1, late: 0, marked: 10 },
        { _id: { classLevel: CLASS_A, date: "2026-10-07" }, present: 10, absent: 0, late: 0, marked: 10 },
        { _id: { classLevel: CLASS_B, date: "2026-10-06" }, present: 3, absent: 2, late: 1, marked: 6 },
        { _id: { classLevel: CLASS_B, date: "2026-10-07" }, present: 4, absent: 2, late: 0, marked: 6 },
      ],
    });
    setupEnrolled({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10 });
    setupClassDocs([
      { _id: CLASS_A, name: "Class A" },
      { _id: CLASS_B, name: "Class B" },
    ]);

    const res = mockRes();
    await getAttendanceDashboardService("2026-10-06", "2026-10-07", "", true, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = payload(res).data;

    // Institute summary: 26 present, 5 absent, 1 late, 32 marked → (26+1)/32
    expect(data.summary).toMatchObject({ present: 26, absent: 5, late: 1, marked: 32 });
    expect(data.summary.rate).toBeCloseTo(84.38, 1);
    expect(data.enrolled).toBe(20);
    expect(data.days).toHaveLength(2);
    expect(data.days[0].rate).toBeCloseTo((12 + 1) / 16 * 100, 1);

    const a = data.classes.find((c) => c.name === "Class A");
    const b = data.classes.find((c) => c.name === "Class B");
    expect(a.incomplete).toBe(false); // 20 records = 10 enrolled × 2 marked days
    expect(a.marked).toBe(20);
    expect(b.incomplete).toBe(true);  // 12 < 20
    expect(b.rate).toBeCloseTo((7 + 1) / 12 * 100, 1);
  });

  it("includes classes with enrolled students but zero records in the range", async () => {
    setupAttendanceAggregates({
      dayAgg: [{ _id: "2026-10-06", present: 5, absent: 0, late: 0, marked: 5 }],
      classDayAgg: [
        { _id: { classLevel: CLASS_A, date: "2026-10-06" }, present: 5, absent: 0, late: 0, marked: 5 },
      ],
    });
    setupEnrolled({ [CLASS_A.toString()]: 5, [CLASS_B.toString()]: 4 });
    setupClassDocs([
      { _id: CLASS_A, name: "Class A" },
      { _id: CLASS_B, name: "Class B" },
    ]);

    const res = mockRes();
    await getAttendanceDashboardService("2026-10-06", "2026-10-06", "", true, res);

    const data = payload(res).data;
    const b = data.classes.find((c) => c.name === "Class B");
    expect(b.marked).toBe(0);
    expect(b.rate).toBeNull();
    expect(b.incomplete).toBe(true);
  });

  it("class scope: enrolled is the class head-count and the class breakdown is skipped", async () => {
    setupAttendanceAggregates({
      dayAgg: [{ _id: "2026-10-06", present: 8, absent: 1, late: 1, marked: 10 }],
    });
    setupEnrolled({ [CLASS_A.toString()]: 12, [CLASS_B.toString()]: 4 });
    setupClassDocs([]);

    const res = mockRes();
    await getAttendanceDashboardService("2026-10-06", "2026-10-06", CLASS_A.toString(), true, res);

    const data = payload(res).data;
    expect(data.enrolled).toBe(12);
    expect(data.classes).toEqual([]);
    expect(data.range.classLevel).toBe(CLASS_A.toString());
    // The daily aggregation was class-filtered
    const dayPipeline = mockAttendanceAggregate.mock.calls[0][0];
    expect(dayPipeline[0].$match.classLevel).toEqual(CLASS_A);
    // No class×day breakdown ran
    expect(mockAttendanceAggregate).toHaveBeenCalledTimes(1);
  });

  it("breakdown=0 skips the class×day aggregation entirely", async () => {
    setupAttendanceAggregates({
      dayAgg: [{ _id: "2026-10-06", present: 10, absent: 0, late: 0, marked: 10 }],
    });
    setupEnrolled({});
    setupClassDocs([]);

    const res = mockRes();
    await getAttendanceDashboardService("2026-10-01", "2026-10-31", "", false, res);

    expect(mockAttendanceAggregate).toHaveBeenCalledTimes(1);
    expect(payload(res).data.classes).toEqual([]);
  });

  it("empty range: zero totals and null rate (never divide by zero)", async () => {
    setupAttendanceAggregates({ dayAgg: [], classDayAgg: [] });
    setupEnrolled({});
    setupClassDocs([]);

    const res = mockRes();
    await getAttendanceDashboardService("2026-10-06", "2026-10-07", "", true, res);

    const data = payload(res).data;
    expect(data.summary.marked).toBe(0);
    expect(data.summary.rate).toBeNull();
    expect(data.days).toEqual([]);
  });

  it("rejects a missing date range with 400", async () => {
    const res = mockRes();
    await getAttendanceDashboardService("", "", "", true, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
