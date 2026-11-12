/**
 * Expected start/end time fields on the teacher STAFF PROFILE (attendance
 * prerequisite). Additive + optional, with one strict blank contract shared
 * by the create and admin-edit paths:
 *   - omitted (undefined) → untouched (API callers that don't know the field
 *     can never accidentally clear it)
 *   - ""                  → explicit clear (the staff form pre-fills and
 *     always submits both fields)
 *   - "HH:MM"             → stored (trimmed)
 *   - anything else       → 400 BEFORE any write / side effect.
 */

const mockTeacherFindOne = jest.fn();
const mockTeacherFindById = jest.fn();
const mockTeacherFindByIdAndUpdate = jest.fn();
const mockTeacherCreate = jest.fn();
const mockAdminFindById = jest.fn();
const mockAdminFindByIdAndUpdate = jest.fn();

jest.mock("../config/logger", () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock("../models/Staff/teachers.model", () => ({
  findOne: (...a) => mockTeacherFindOne(...a),
  findById: (...a) => mockTeacherFindById(...a),
  findByIdAndUpdate: (...a) => mockTeacherFindByIdAndUpdate(...a),
  create: (...a) => mockTeacherCreate(...a),
}));
jest.mock("../models/Staff/admin.model", () => ({
  findById: (...a) => mockAdminFindById(...a),
  findByIdAndUpdate: (...a) => mockAdminFindByIdAndUpdate(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({ deleteMany: jest.fn() }));
jest.mock("../models/Academic/testResult.model", () => ({ updateMany: jest.fn() }));
jest.mock("../models/Academic/attendance.model", () => ({ updateMany: jest.fn() }));
// The login-capture hook lives in the attendance service — not under test here.
jest.mock("../services/staff/teacherAttendance.service", () => ({
  recordTeacherLoginArrival: jest.fn(),
}));

const mongoose = require("mongoose");
const {
  createTeacherService,
  adminUpdateCredentialsService,
} = require("../services/staff/teachers.service");

const ADMIN = new mongoose.Types.ObjectId();
const TEACHER = new mongoose.Types.ObjectId();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  // Admin caller (create path authorizes on the Admin lookup).
  mockAdminFindById.mockResolvedValue({ _id: ADMIN });
  mockAdminFindByIdAndUpdate.mockResolvedValue({});
  mockTeacherFindOne.mockResolvedValue(null); // no email collision
  mockTeacherCreate.mockImplementation((doc) => Promise.resolve({ _id: TEACHER, ...doc }));
  // Create path manager-check: Teacher.findById(...).select(...).lean() → no
  // teacher caller (the Admin lookup above already authorizes).
  mockTeacherFindById.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(null),
  });
});

const teacherDocForUpdate = () => ({
  _id: TEACHER,
  email: "t@x.test",
  toObject: function () { return { _id: this._id, email: this.email }; },
});

describe("createTeacherService — expected times at registration", () => {
  const base = { name: "T One", email: "t@x.test", password: "Passw0rd!" };

  it("stores valid HH:MM times (trimmed)", async () => {
    const res = mockRes();
    await createTeacherService(
      { ...base, expectedArrivalTime: " 08:00 ", expectedDepartureTime: "16:30" }, ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockTeacherCreate.mock.calls[0][0]).toMatchObject({
      expectedArrivalTime: "08:00", expectedDepartureTime: "16:30",
    });
  });

  it("omitted fields → stored as '' (optional; late detection stays skipped)", async () => {
    const res = mockRes();
    await createTeacherService(base, ADMIN, res);
    expect(mockTeacherCreate.mock.calls[0][0]).toMatchObject({
      expectedArrivalTime: "", expectedDepartureTime: "",
    });
  });

  it.each(["8am", "24:00", "8:00", "08:60"])("malformed %p → 400, NO account created", async (bad) => {
    const res = mockRes();
    await createTeacherService({ ...base, expectedArrivalTime: bad }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    // Validated up front — before the email lookup and any side effect.
    expect(mockTeacherFindOne).not.toHaveBeenCalled();
    expect(mockTeacherCreate).not.toHaveBeenCalled();
  });
});

describe("adminUpdateCredentialsService — expected times on edit", () => {
  beforeEach(() => {
    mockTeacherFindById.mockReset();
    mockTeacherFindById.mockResolvedValue(teacherDocForUpdate());
    mockTeacherFindByIdAndUpdate.mockResolvedValue(teacherDocForUpdate());
  });

  it("sets provided times and leaves untouched sides out of the update", async () => {
    const res = mockRes();
    await adminUpdateCredentialsService(
      { name: "T One", expectedArrivalTime: "07:45" }, TEACHER, res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const update = mockTeacherFindByIdAndUpdate.mock.calls[0][1];
    expect(update.$set).toMatchObject({ expectedArrivalTime: "07:45" });
    // Departure omitted → NOT written (can't be cleared accidentally).
    expect(update.$set.expectedDepartureTime).toBeUndefined();
  });

  it('"" clears a stored expectation on purpose', async () => {
    const res = mockRes();
    await adminUpdateCredentialsService(
      { expectedArrivalTime: "", expectedDepartureTime: "" }, TEACHER, res
    );
    const update = mockTeacherFindByIdAndUpdate.mock.calls[0][1];
    expect(update.$set).toMatchObject({ expectedArrivalTime: "", expectedDepartureTime: "" });
  });

  it("malformed time → 400 before anything is read or written", async () => {
    const res = mockRes();
    await adminUpdateCredentialsService({ expectedDepartureTime: "7:45pm" }, TEACHER, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTeacherFindById).not.toHaveBeenCalled();
    expect(mockTeacherFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("requests without the fields behave exactly as before (regression)", async () => {
    const res = mockRes();
    await adminUpdateCredentialsService({ name: "Renamed" }, TEACHER, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const update = mockTeacherFindByIdAndUpdate.mock.calls[0][1];
    expect(update.$set).toEqual({ name: "Renamed" });
  });
});
