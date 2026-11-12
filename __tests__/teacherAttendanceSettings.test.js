/**
 * Late-arrival rule tests (Phase 1):
 * - Defaults: detection DISABLED until an admin enables it.
 * - Admin write validates start time + grace bounds before any write.
 * - Saving re-derives isLate/lateMinutes on existing records (changed only),
 *   so stored flags always match the current rule.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockSettingsFindOne = jest.fn();
const mockSettingsFindOneAndUpdate = jest.fn();
const mockTaFind = jest.fn();
const mockTaBulkWrite = jest.fn();
const mockTeacherFind = jest.fn();

jest.mock("../models/Staff/teacherAttendanceSettings.model", () => ({
  findOne: (...a) => mockSettingsFindOne(...a),
  findOneAndUpdate: (...a) => mockSettingsFindOneAndUpdate(...a),
}));
jest.mock("../models/Staff/teacherAttendance.model", () => ({
  find: (...a) => mockTaFind(...a),
  bulkWrite: (...a) => mockTaBulkWrite(...a),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  find: (...a) => mockTeacherFind(...a),
}));

const mongoose = require("mongoose");
const {
  getTeacherAttendanceSettingsService,
  updateTeacherAttendanceSettingsService,
} = require("../services/staff/teacherAttendance.service");

const ADMIN = new mongoose.Types.ObjectId();
const R1 = new mongoose.Types.ObjectId();
const R2 = new mongoose.Types.ObjectId();
const T1 = new mongoose.Types.ObjectId();
const T2 = new mongoose.Types.ObjectId();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];
const leanChain = (doc) => ({ lean: jest.fn().mockResolvedValue(doc) });

function setupExisting(records) {
  mockTaFind.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(records),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSettingsFindOne.mockReturnValue(leanChain(null));
  setupExisting([]);
  mockTaBulkWrite.mockResolvedValue({ modifiedCount: 0 });
  // Re-flag pass reads every teacher's expected arrival time; default both
  // profiled teachers to an 08:00 expectation.
  mockTeacherFind.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([
      { _id: T1, expectedArrivalTime: "08:00" },
      { _id: T2, expectedArrivalTime: "08:00" },
    ]),
  });
});

describe("getTeacherAttendanceSettingsService", () => {
  it("no settings doc yet → disabled defaults", async () => {
    const res = mockRes();
    await getTeacherAttendanceSettingsService(res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({
      lateDetectionEnabled: false,
      startTime: "08:00",
      graceMinutes: 5,
    });
  });

  it("returns the stored rule when configured", async () => {
    mockSettingsFindOne.mockReturnValue(leanChain({
      lateDetectionEnabled: true, startTime: "07:45", graceMinutes: 15,
    }));
    const res = mockRes();
    await getTeacherAttendanceSettingsService(res);
    expect(payload(res).data).toMatchObject({
      lateDetectionEnabled: true, startTime: "07:45", graceMinutes: 15,
    });
  });
});

describe("updateTeacherAttendanceSettingsService — validation", () => {
  it.each([
    ["bad start time", { lateDetectionEnabled: true, startTime: "8:00", graceMinutes: 10 }],
    ["negative grace", { lateDetectionEnabled: true, startTime: "08:00", graceMinutes: -1 }],
    ["grace over 240", { lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 241 }],
    ["fractional grace", { lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 1.5 }],
    ["non-numeric grace", { lateDetectionEnabled: true, startTime: "08:00", graceMinutes: "abc" }],
  ])("%s → 400 and nothing written", async (_label, body) => {
    const res = mockRes();
    await updateTeacherAttendanceSettingsService(body, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSettingsFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockTaBulkWrite).not.toHaveBeenCalled();
  });
});

describe("updateTeacherAttendanceSettingsService — write + re-flag", () => {
  it("upserts the singleton rule and re-flags existing records under it", async () => {
    mockSettingsFindOneAndUpdate.mockReturnValue(leanChain({
      lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10,
    }));
    // R1 arrived 08:35 → becomes late (+25); R2 arrived 07:55 → stays on time.
    // (Both teachers' profiles expect 08:00; grace 10 → cutoff 08:10.)
    setupExisting([
      { _id: R1, teacher: T1, arrivalTime: "08:35", isLate: false, lateMinutes: 0 },
      { _id: R2, teacher: T2, arrivalTime: "07:55", isLate: false, lateMinutes: 0 },
    ]);

    const res = mockRes();
    await updateTeacherAttendanceSettingsService(
      { lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10 }, ADMIN, res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const [filter, update, opts] = mockSettingsFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ key: "default" });
    expect(update.$set).toMatchObject({ lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10, updatedBy: ADMIN });
    expect(opts).toMatchObject({ upsert: true, new: true });

    // Only the changed record is written
    expect(mockTaBulkWrite).toHaveBeenCalledTimes(1);
    const ops = mockTaBulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(1);
    expect(ops[0].updateOne.filter).toEqual({ _id: R1 });
    expect(ops[0].updateOne.update.$set).toEqual({ isLate: true, lateMinutes: 25 });
    expect(payload(res).data.reflagged).toBe(1);
  });

  it("disabling the rule clears previously set late flags", async () => {
    mockSettingsFindOneAndUpdate.mockReturnValue(leanChain({
      lateDetectionEnabled: false, startTime: "08:00", graceMinutes: 10,
    }));
    setupExisting([
      { _id: R1, teacher: T1, arrivalTime: "08:35", isLate: true, lateMinutes: 25 },
    ]);

    const res = mockRes();
    await updateTeacherAttendanceSettingsService(
      { lateDetectionEnabled: false, startTime: "08:00", graceMinutes: 10 }, ADMIN, res
    );

    const ops = mockTaBulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set).toEqual({ isLate: false, lateMinutes: 0 });
    expect(payload(res).data.reflagged).toBe(1);
  });

  it("no flag changes → no bulk write at all", async () => {
    mockSettingsFindOneAndUpdate.mockReturnValue(leanChain({
      lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10,
    }));
    setupExisting([
      { _id: R1, teacher: T1, arrivalTime: "08:35", isLate: true, lateMinutes: 25 },
    ]);

    const res = mockRes();
    await updateTeacherAttendanceSettingsService(
      { lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10 }, ADMIN, res
    );

    expect(mockTaBulkWrite).not.toHaveBeenCalled();
    expect(payload(res).data.reflagged).toBe(0);
  });

  it("teacher with NO expected arrival time → flags cleared (late detection skipped)", async () => {
    mockSettingsFindOneAndUpdate.mockReturnValue(leanChain({
      lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10,
    }));
    mockTeacherFind.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: T1, expectedArrivalTime: "" }]),
    });
    setupExisting([
      { _id: R1, teacher: T1, arrivalTime: "08:35", isLate: true, lateMinutes: 25 },
    ]);

    const res = mockRes();
    await updateTeacherAttendanceSettingsService(
      { lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10 }, ADMIN, res
    );

    // The profile has no expectation → never late, whatever the global start
    // time says. The stale flag is cleared, not kept against the fallback.
    const ops = mockTaBulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set).toEqual({ isLate: false, lateMinutes: 0 });
    expect(payload(res).data.reflagged).toBe(1);
  });
});