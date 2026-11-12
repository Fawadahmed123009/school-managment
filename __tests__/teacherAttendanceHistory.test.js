/**
 * History/summary tests for teacher attendance (Phase 1):
 * - Date range is inclusive on both ends (endDate pushed to next-day $lt).
 * - Optional teacher filter narrows BOTH the paged records and the totals.
 * - Working-hours sums come from aggregation over the WHOLE range, not the
 *   current page (this is the number Phase 2 salary will consume).
 * - Invalid ranges / teacher ids → 400.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockTaFind = jest.fn();
const mockTaCountDocuments = jest.fn();
const mockTaAggregate = jest.fn();
const mockTeacherFind = jest.fn();

jest.mock("../models/Staff/teacherAttendance.model", () => ({
  find: (...a) => mockTaFind(...a),
  countDocuments: (...a) => mockTaCountDocuments(...a),
  aggregate: (...a) => mockTaAggregate(...a),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  find: (...a) => mockTeacherFind(...a),
}));
jest.mock("../models/Staff/teacherAttendanceSettings.model", () => ({
  findOne: jest.fn(),
}));

const mongoose = require("mongoose");
const { getTeacherAttendanceHistoryService } = require("../services/staff/teacherAttendance.service");

const T1 = new mongoose.Types.ObjectId();
const T2 = new mongoose.Types.ObjectId();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];

// paginate() chain: find → skip → limit → sort → populate → lean
function setupRecords(records, total) {
  const chain = {
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(records),
  };
  mockTaFind.mockReturnValue(chain);
  mockTaCountDocuments.mockResolvedValue(total);
  return chain;
}

// Route the two aggregates by $group shape: overall totals (_id: null) vs
// per-teacher breakdown (_id: "$teacher").
function setupAggregates({ totals = [], perTeacher = [] }) {
  mockTaAggregate.mockImplementation((pipeline) => {
    const group = pipeline.find((s) => s.$group);
    if (group && group.$group._id === null) return Promise.resolve(totals);
    return Promise.resolve(perTeacher);
  });
}

function setupTeacherNames(docs) {
  mockTeacherFind.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(docs),
  });
}

beforeEach(() => jest.clearAllMocks());

describe("getTeacherAttendanceHistoryService", () => {
  it("sums working minutes across the range and breaks them down per teacher", async () => {
    const records = [
      { _id: new mongoose.Types.ObjectId(), teacher: { _id: T1, name: "Ayesha", teacherId: "TEA001" }, date: new Date(2026, 10, 10), arrivalTime: "08:00", departureTime: "15:30", workingMinutes: 450, isLate: false, lateMinutes: 0 },
    ];
    setupRecords(records, 3);
    setupAggregates({
      totals: [{ _id: null, totalMinutes: 1260, records: 3, lateCount: 1 }],
      perTeacher: [
        { _id: T1, totalMinutes: 810, days: 2, lateCount: 1 },
        { _id: T2, totalMinutes: 450, days: 1, lateCount: 0 },
      ],
    });
    setupTeacherNames([
      { _id: T1, name: "Ayesha", teacherId: "TEA001" },
      { _id: T2, name: "Bilal", teacherId: "TEA002" },
    ]);

    const res = mockRes();
    await getTeacherAttendanceHistoryService({ startDate: "2026-11-01", endDate: "2026-11-10" }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = payload(res).data;

    // Overall sum: 1260 min = 21 h
    expect(data.summary).toEqual({ totalMinutes: 1260, totalHours: 21, records: 3, lateCount: 1 });
    // Per-teacher breakdown carries names + hour sums
    expect(data.perTeacher[0]).toMatchObject({ name: "Ayesha", days: 2, totalMinutes: 810, totalHours: 13.5, lateCount: 1 });
    expect(data.perTeacher[1]).toMatchObject({ name: "Bilal", totalMinutes: 450, totalHours: 7.5 });
    expect(data.records).toHaveLength(1);
    expect(data.pagination.total).toBe(3);
  });

  it("endDate is inclusive: $lt pushes to the next local midnight", async () => {
    setupRecords([], 0);
    setupAggregates({});
    setupTeacherNames([]);

    const res = mockRes();
    await getTeacherAttendanceHistoryService({ startDate: "2026-11-01", endDate: "2026-11-10" }, res);

    const match = mockTaFind.mock.calls[0][0];
    expect(match.date.$gte).toEqual(new Date(2026, 10, 1));
    expect(match.date.$lt).toEqual(new Date(2026, 10, 11));
  });

  it("teacher filter narrows records AND both aggregates", async () => {
    setupRecords([], 0);
    setupAggregates({});
    setupTeacherNames([]);

    const res = mockRes();
    await getTeacherAttendanceHistoryService(
      { startDate: "2026-11-01", endDate: "2026-11-10", teacherId: T1.toString() },
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockTaFind.mock.calls[0][0].teacher).toEqual(T1);
    for (const call of mockTaAggregate.mock.calls) {
      expect(call[0][0].$match.teacher).toEqual(T1);
    }
    expect(payload(res).data.range.teacherId).toBe(T1.toString());
  });

  it("empty range → zero totals, never divide by zero", async () => {
    setupRecords([], 0);
    setupAggregates({ totals: [], perTeacher: [] });
    setupTeacherNames([]);

    const res = mockRes();
    await getTeacherAttendanceHistoryService({ startDate: "2026-11-01", endDate: "2026-11-10" }, res);

    const data = payload(res).data;
    expect(data.summary).toEqual({ totalMinutes: 0, totalHours: 0, records: 0, lateCount: 0 });
    expect(data.perTeacher).toEqual([]);
  });

  it.each([
    ["missing dates", {}],
    ["bad format", { startDate: "01-11-2026", endDate: "2026-11-10" }],
    ["start after end", { startDate: "2026-11-10", endDate: "2026-11-01" }],
    ["invalid teacher id", { startDate: "2026-11-01", endDate: "2026-11-10", teacherId: "xyz" }],
  ])("%s → 400", async (_label, filters) => {
    const res = mockRes();
    await getTeacherAttendanceHistoryService(filters, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTaFind).not.toHaveBeenCalled();
  });
});