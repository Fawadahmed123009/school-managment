/**
 * Login/logout auto-capture tests (Phase 1 update):
 * - First login of the day fixes the arrival (source "login"); re-logins
 *   keep the EARLIEST value.
 * - Explicit logout fixes the departure (source "logout"); the LAST logout
 *   wins; a logout never fabricates a day with no arrival.
 * - Manager-marked sides ("manual", incl. legacy records lacking a source)
 *   are NEVER overwritten by the auto paths.
 * - The late flag is computed at capture time against the teacher's OWN
 *   expected arrival time from the staff profile (+ admin grace); a profile
 *   without one is never flagged.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockTeacherFindOne = jest.fn();
const mockTaFindOne = jest.fn();
const mockTaCreate = jest.fn();
const mockTaFindByIdAndUpdate = jest.fn();
const mockSettingsFindOne = jest.fn();

jest.mock("../config/logger", () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock("../models/Staff/teachers.model", () => ({
  findOne: (...a) => mockTeacherFindOne(...a),
}));
jest.mock("../models/Staff/teacherAttendance.model", () => ({
  findOne: (...a) => mockTaFindOne(...a),
  create: (...a) => mockTaCreate(...a),
  findByIdAndUpdate: (...a) => mockTaFindByIdAndUpdate(...a),
}));
jest.mock("../models/Staff/teacherAttendanceSettings.model", () => ({
  findOne: (...a) => mockSettingsFindOne(...a),
}));

const mongoose = require("mongoose");
const {
  recordTeacherLoginArrival,
  recordTeacherLogoutDeparture,
} = require("../services/staff/teacherAttendance.service");

const T1 = new mongoose.Types.ObjectId();

const at = (h, m) => new Date(2026, 10, 12, h, m, 0, 0); // 2026-11-12 local
const leanChain = (doc) => ({ lean: jest.fn().mockResolvedValue(doc) });
const selectLeanChain = (doc) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockTeacherFindOne.mockReturnValue(selectLeanChain({ _id: T1 })); // active teacher by default
  mockSettingsFindOne.mockReturnValue(leanChain(null)); // defaults: rule disabled
  mockTaFindOne.mockReturnValue(leanChain(null)); // no record yet
  mockTaCreate.mockImplementation((doc) => Promise.resolve({ _id: new mongoose.Types.ObjectId(), ...doc }));
  mockTaFindByIdAndUpdate.mockImplementation((id, update) => Promise.resolve({ _id: id, ...update.$set }));
});

describe("recordTeacherLoginArrival", () => {
  it("first login of the day creates the record with arrival from login", async () => {
    const rec = await recordTeacherLoginArrival(T1, at(8, 5));
    expect(mockTaCreate).toHaveBeenCalledTimes(1);
    const created = mockTaCreate.mock.calls[0][0];
    expect(created).toMatchObject({
      teacher: T1,
      arrivalTime: "08:05",
      departureTime: "",
      workingMinutes: 0,
      arrivalSource: "login",
      createdBy: T1, // the login itself wrote the row
      isLate: false,
      lateMinutes: 0,
    });
    expect(created.date).toEqual(new Date(2026, 10, 12)); // local midnight bucket
    expect(rec.arrivalTime).toBe("08:05");
  });

  it("computes the late flag at capture against the profile's expected time", async () => {
    mockTeacherFindOne.mockReturnValue(selectLeanChain({ _id: T1, expectedArrivalTime: "08:00" }));
    mockSettingsFindOne.mockReturnValue(leanChain({
      lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 5,
    }));
    await recordTeacherLoginArrival(T1, at(8, 10)); // 08:05 deadline → +5 late
    expect(mockTaCreate.mock.calls[0][0]).toMatchObject({ isLate: true, lateMinutes: 5 });
  });

  it("no expected arrival on the profile → never late, even under an enabled rule", async () => {
    mockTeacherFindOne.mockReturnValue(selectLeanChain({ _id: T1 })); // expectation unset
    mockSettingsFindOne.mockReturnValue(leanChain({
      lateDetectionEnabled: true, startTime: "07:00", graceMinutes: 0,
    }));
    await recordTeacherLoginArrival(T1, at(12, 0));
    expect(mockTaCreate.mock.calls[0][0]).toMatchObject({ isLate: false, lateMinutes: 0 });
  });

  it("withdrawn or unknown teacher → null, no record touched", async () => {
    mockTeacherFindOne.mockReturnValue(selectLeanChain(null));
    expect(await recordTeacherLoginArrival(T1, at(8, 5))).toBeNull();
    expect(mockTaFindOne).not.toHaveBeenCalled();
    expect(mockTaCreate).not.toHaveBeenCalled();
  });

  it("manager-marked arrival is never overwritten by a login", async () => {
    const existing = { _id: "R", arrivalTime: "07:30", arrivalSource: "manual" };
    mockTaFindOne.mockReturnValue(leanChain(existing));
    const rec = await recordTeacherLoginArrival(T1, at(8, 30));
    expect(rec).toBe(existing);
    expect(mockTaFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(mockTaCreate).not.toHaveBeenCalled();
  });

  it("legacy record without a source counts as manual → untouched", async () => {
    const existing = { _id: "R", arrivalTime: "07:30" }; // pre-login-capture doc
    mockTaFindOne.mockReturnValue(leanChain(existing));
    expect(await recordTeacherLoginArrival(T1, at(9, 0))).toBe(existing);
    expect(mockTaFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("re-login later in the day keeps the EARLIEST login arrival", async () => {
    const existing = { _id: "R", arrivalTime: "07:55", arrivalSource: "login" };
    mockTaFindOne.mockReturnValue(leanChain(existing));
    expect(await recordTeacherLoginArrival(T1, at(9, 0))).toBe(existing);
    expect(mockTaFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("an earlier login refines the captured arrival (+ late flag)", async () => {
    mockTeacherFindOne.mockReturnValue(selectLeanChain({ _id: T1, expectedArrivalTime: "08:00" }));
    mockSettingsFindOne.mockReturnValue(leanChain({
      lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 5,
    }));
    const existing = { _id: "R", arrivalTime: "08:20", arrivalSource: "login" };
    mockTaFindOne.mockReturnValue(leanChain(existing));
    await recordTeacherLoginArrival(T1, at(8, 3)); // on time
    const [id, update] = mockTaFindByIdAndUpdate.mock.calls[0];
    expect(id).toBe("R");
    expect(update.$set).toMatchObject({ arrivalTime: "08:03", isLate: false, lateMinutes: 0, updatedBy: T1 });
  });
});

describe("recordTeacherLogoutDeparture", () => {
  it("logout closes the open day and derives working minutes", async () => {
    mockTaFindOne.mockReturnValue(leanChain({ _id: "R", arrivalTime: "08:05", departureTime: "" }));
    await recordTeacherLogoutDeparture(T1, at(15, 35));
    const [id, update, opts] = mockTaFindByIdAndUpdate.mock.calls[0];
    expect(id).toBe("R");
    expect(update.$set).toMatchObject({
      departureTime: "15:35",
      departureSource: "logout",
      workingMinutes: 450,
      updatedBy: T1,
    });
    expect(opts).toMatchObject({ new: true });
  });

  it("the LAST logout wins over an earlier captured one", async () => {
    mockTaFindOne.mockReturnValue(leanChain({
      _id: "R", arrivalTime: "08:00", departureTime: "13:00", departureSource: "logout",
    }));
    await recordTeacherLogoutDeparture(T1, at(16, 0));
    expect(mockTaFindByIdAndUpdate.mock.calls[0][1].$set)
      .toMatchObject({ departureTime: "16:00", workingMinutes: 480 });
  });

  it("manager-marked departure is never overwritten", async () => {
    const existing = {
      _id: "R", arrivalTime: "08:00", departureTime: "15:30", departureSource: "manual",
    };
    mockTaFindOne.mockReturnValue(leanChain(existing));
    expect(await recordTeacherLogoutDeparture(T1, at(16, 0))).toBe(existing);
    expect(mockTaFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("no record for the day → null (logout never fabricates attendance)", async () => {
    expect(await recordTeacherLogoutDeparture(T1, at(15, 0))).toBeNull();
    expect(mockTaFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(mockTaCreate).not.toHaveBeenCalled();
  });

  it("record without an arrival → null", async () => {
    mockTaFindOne.mockReturnValue(leanChain({ _id: "R", arrivalTime: "" }));
    expect(await recordTeacherLogoutDeparture(T1, at(15, 0))).toBeNull();
    expect(mockTaFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("same-minute login→logout → 0 minutes, never negative", async () => {
    mockTaFindOne.mockReturnValue(leanChain({ _id: "R", arrivalTime: "09:00", departureTime: "" }));
    await recordTeacherLogoutDeparture(T1, at(9, 0));
    expect(mockTaFindByIdAndUpdate.mock.calls[0][1].$set.workingMinutes).toBe(0);
  });
});
