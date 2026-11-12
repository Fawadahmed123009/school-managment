/**
 * Audit hooks — attendance paths (Phase 1 manual marking/correction) and
 * teacher expected arrival/departure times (create + credentials edit).
 * The audit recorder is mocked so these tests assert WHAT each hook records
 * (action, entity, summary, changed-field snapshots) and that failed
 * validations / no-op saves record NOTHING. The recorder's own fail-open
 * contract is proven in auditLogService.test.js.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

jest.mock("../services/audit/auditLog.service", () => {
  const actual = jest.requireActual("../services/audit/auditLog.service");
  return { ...actual, recordAudit: jest.fn() };
});

const mockTeacherFind = jest.fn();
const mockTeacherFindOne = jest.fn();
const mockTeacherFindById = jest.fn();
const mockTeacherCreate = jest.fn();
const mockTeacherFindByIdAndUpdate = jest.fn();
const mockAdminFindById = jest.fn();
const mockAdminFindByIdAndUpdate = jest.fn();
const mockTaFindOneAndUpdate = jest.fn();
const mockTaFind = jest.fn();
const mockSettingsFindOne = jest.fn();

jest.mock("../models/Staff/teachers.model", () => ({
  find: (...a) => mockTeacherFind(...a),
  findOne: (...a) => mockTeacherFindOne(...a),
  findById: (...a) => mockTeacherFindById(...a),
  create: (...a) => mockTeacherCreate(...a),
  findByIdAndUpdate: (...a) => mockTeacherFindByIdAndUpdate(...a),
}));
jest.mock("../models/Staff/admin.model", () => ({
  findById: (...a) => mockAdminFindById(...a),
  findByIdAndUpdate: (...a) => mockAdminFindByIdAndUpdate(...a),
}));
jest.mock("../models/Staff/teacherAttendance.model", () => ({
  findOneAndUpdate: (...a) => mockTaFindOneAndUpdate(...a),
  find: (...a) => mockTaFind(...a),
}));
jest.mock("../models/Staff/teacherAttendanceSettings.model", () => ({
  findOne: (...a) => mockSettingsFindOne(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({ deleteMany: jest.fn() }));
jest.mock("../models/Academic/testResult.model", () => ({ updateMany: jest.fn() }));
jest.mock("../models/Academic/attendance.model", () => ({ updateMany: jest.fn() }));
jest.mock("../utils/tokenGenerator", () => jest.fn(() => "tok"));
// Real password policy, stubbed bcrypt (same convention as teacherAccountSettings.test.js).
jest.mock("../handlers/passHash.handler", () => {
  const REAL = jest.requireActual("../handlers/passHash.handler");
  return {
    validatePassword: REAL.validatePassword,
    hashPassword: jest.fn(async (pw) => `hashed_${pw}`),
    isPassMatched: jest.fn(async (plain, hash) => hash === `hashed_${plain}`),
  };
});

const mongoose = require("mongoose");
const { recordAudit } = require("../services/audit/auditLog.service");
const { markTeacherAttendanceService } = require("../services/staff/teacherAttendance.service");
const {
  createTeacherService,
  adminUpdateCredentialsService,
} = require("../services/staff/teachers.service");

const ADMIN = new mongoose.Types.ObjectId();
const MARKER = new mongoose.Types.ObjectId();
const T1 = new mongoose.Types.ObjectId();
const NEW_T = new mongoose.Types.ObjectId();
const ROW_ID = new mongoose.Types.ObjectId();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const leanChain = (doc) => ({ lean: jest.fn().mockResolvedValue(doc) });
const selectLeanChain = (doc) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(doc) });
const teacherChain = (docs) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(docs),
});
const lastAudit = () => recordAudit.mock.calls[recordAudit.mock.calls.length - 1][0];

beforeEach(() => {
  jest.clearAllMocks();
  // Marking defaults (teacherAttendanceMarking.test.js harness): T1 active
  // with an 08:00 expectation, no settings doc, no existing rows.
  mockTeacherFind.mockReturnValue(teacherChain([{ _id: T1, expectedArrivalTime: "08:00" }]));
  mockSettingsFindOne.mockReturnValue(leanChain(null));
  mockTaFind.mockReturnValue(leanChain([]));
  mockTaFindOneAndUpdate.mockImplementation(async (filter, update) => ({
    _id: ROW_ID,
    ...update.$set,
    ...(update.$setOnInsert || {}),
  }));
  // Credentials defaults: stored teacher with both expected times set.
  mockTeacherFindOne.mockResolvedValue(null);
  mockTeacherFindById.mockResolvedValue({
    _id: T1, name: "Alice", email: "alice@school.edu",
    expectedArrivalTime: "08:00", expectedDepartureTime: "14:00",
  });
  mockTeacherFindByIdAndUpdate.mockImplementation(async (id, update) => ({
    toObject: () => ({ _id: T1, name: "Alice", ...update.$set }),
  }));
  mockTeacherCreate.mockImplementation(async (doc) => ({ _id: NEW_T, ...doc }));
  mockAdminFindById.mockResolvedValue({ _id: ADMIN });
  mockAdminFindByIdAndUpdate.mockResolvedValue({});
});

// ── manual marking / correction (Phase 1) ───────────────────────────────────

describe("markTeacherAttendanceService hooks", () => {
  it("new manual mark → create/teacher_attendance with the full pair snapshot", async () => {
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: String(T1), arrivalTime: "08:00", departureTime: "15:30" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const entry = lastAudit();
    expect(entry).toMatchObject({
      userId: MARKER,
      actionType: "create",
      entityType: "teacher_attendance",
      entityId: ROW_ID,
      teacherId: String(T1),
    });
    expect(entry.summary).toContain("Manually marked attendance for {teacher} on 10 Nov 2026");
    expect(entry.summary).toContain("arrival 08:00");
    expect(entry.summary).toContain("departure 15:30");
    expect(entry.beforeSnapshot).toBeUndefined();
    expect(entry.afterSnapshot).toEqual({
      arrivalTime: "08:00",
      departureTime: "15:30",
      arrivalSource: "manual",
      departureSource: "manual",
    });
  });

  it("arrival correction → update with ONLY the changed time + provenance", async () => {
    mockTaFind.mockReturnValue(leanChain([{
      _id: ROW_ID, teacher: T1, arrivalTime: "08:00", departureTime: "15:30",
      arrivalSource: "login", departureSource: "logout",
    }]));
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: String(T1), arrivalTime: "08:15" }], // departure omitted → preserved
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    const entry = lastAudit();
    expect(entry).toMatchObject({ actionType: "update", entityType: "teacher_attendance", teacherId: String(T1) });
    expect(entry.summary).toContain("Corrected attendance for {teacher} on 10 Nov 2026");
    expect(entry.beforeSnapshot).toEqual({ arrivalTime: "08:00", arrivalSource: "login" });
    expect(entry.afterSnapshot).toEqual({ arrivalTime: "08:15", arrivalSource: "manual" });
  });

  it("departure-only correction (forgot to log out) keeps the login arrival", async () => {
    mockTaFind.mockReturnValue(leanChain([{
      _id: ROW_ID, teacher: T1, arrivalTime: "08:00", departureTime: "",
      arrivalSource: "login", departureSource: "",
    }]));
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: String(T1), departureTime: "16:00" }],
      MARKER, res
    );
    const entry = lastAudit();
    expect(entry.beforeSnapshot).toEqual({ departureTime: "" });
    expect(entry.afterSnapshot).toEqual({ departureTime: "16:00" });
  });

  it("no-op resubmission (same values) → NO audit row", async () => {
    mockTaFind.mockReturnValue(leanChain([{
      _id: ROW_ID, teacher: T1, arrivalTime: "08:00", departureTime: "15:30",
      arrivalSource: "manual", departureSource: "manual",
    }]));
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: String(T1), arrivalTime: "08:00", departureTime: "15:30" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("legacy row without sources → same values produce NO phantom provenance diff", async () => {
    mockTaFind.mockReturnValue(leanChain([{
      _id: ROW_ID, teacher: T1, arrivalTime: "08:00", departureTime: "15:30",
      // pre-login-capture row: no arrivalSource/departureSource fields
    }]));
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: String(T1), arrivalTime: "08:00", departureTime: "15:30" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("withdrawn/unknown teacher → 403, nothing written, NO audit row", async () => {
    mockTeacherFind.mockReturnValue(teacherChain([])); // not in the allowed set
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: String(T1), arrivalTime: "08:00", departureTime: "15:30" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("invalid time → 400 before any write, NO audit row", async () => {
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: String(T1), arrivalTime: "25:00", departureTime: "15:30" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

// ── expected times at teacher creation ──────────────────────────────────────

describe("createTeacherService hooks", () => {
  beforeEach(() => {
    // The caller check reads Teacher.findById(...).select(...).lean().
    mockTeacherFindById.mockReturnValue(selectLeanChain(null));
  });

  it("times set at creation → create/teacher_expected_times", async () => {
    const res = mockRes();
    await createTeacherService(
      { name: "Alice", email: "alice@school.edu", password: "tea123pass",
        expectedArrivalTime: "08:00", expectedDepartureTime: "14:00" },
      ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const entry = lastAudit();
    expect(entry).toMatchObject({
      userId: ADMIN,
      actionType: "create",
      entityType: "teacher_expected_times",
      entityId: NEW_T,
    });
    expect(entry.summary).toContain("Set expected times for new teacher Alice");
    expect(entry.afterSnapshot).toEqual({ expectedArrivalTime: "08:00", expectedDepartureTime: "14:00" });
  });

  it("no times at creation → NO audit row", async () => {
    const res = mockRes();
    await createTeacherService(
      { name: "Bob", email: "bob@school.edu", password: "tea123pass" },
      ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("malformed time → 400 before any write, NO audit row", async () => {
    const res = mockRes();
    await createTeacherService(
      { name: "Bob", email: "bob@school.edu", password: "tea123pass", expectedArrivalTime: "8am" },
      ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTeacherCreate).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

// ── expected times via credentials edit ─────────────────────────────────────

describe("adminUpdateCredentialsService hooks", () => {
  it("arrival change → update/teacher_expected_times with the changed field only", async () => {
    const res = mockRes();
    await adminUpdateCredentialsService(
      { expectedArrivalTime: "08:30" }, String(T1), res, ADMIN
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const entry = lastAudit();
    expect(entry).toMatchObject({
      userId: ADMIN,
      actionType: "update",
      entityType: "teacher_expected_times",
      entityId: String(T1),
    });
    expect(entry.summary).toContain("Updated expected times for Alice");
    expect(entry.summary).toContain("arrival 08:00 → 08:30");
    expect(entry.beforeSnapshot).toEqual({ expectedArrivalTime: "08:00" });
    expect(entry.afterSnapshot).toEqual({ expectedArrivalTime: "08:30" });
  });

  it("both times changed → both fields in the diff and summary", async () => {
    const res = mockRes();
    await adminUpdateCredentialsService(
      { expectedArrivalTime: "09:00", expectedDepartureTime: "15:00" }, String(T1), res, ADMIN
    );
    const entry = lastAudit();
    expect(entry.beforeSnapshot).toEqual({ expectedArrivalTime: "08:00", expectedDepartureTime: "14:00" });
    expect(entry.afterSnapshot).toEqual({ expectedArrivalTime: "09:00", expectedDepartureTime: "15:00" });
    expect(entry.summary).toContain("departure 14:00 → 15:00");
  });

  it("explicit clear (blank submit) → update with empty-string after value", async () => {
    const res = mockRes();
    await adminUpdateCredentialsService(
      { expectedArrivalTime: "" }, String(T1), res, ADMIN
    );
    const entry = lastAudit();
    expect(entry.beforeSnapshot).toEqual({ expectedArrivalTime: "08:00" });
    expect(entry.afterSnapshot).toEqual({ expectedArrivalTime: "" });
    expect(entry.summary).toContain("arrival 08:00 → —");
  });

  it("same times resubmitted → NO audit row", async () => {
    const res = mockRes();
    await adminUpdateCredentialsService(
      { expectedArrivalTime: "08:00", expectedDepartureTime: "14:00" }, String(T1), res, ADMIN
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("times absent from the request (name-only edit) → NO audit row", async () => {
    const res = mockRes();
    await adminUpdateCredentialsService({ name: "Alice Khan" }, String(T1), res, ADMIN);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("malformed time → 400 before any write, NO audit row", async () => {
    const res = mockRes();
    await adminUpdateCredentialsService(
      { expectedArrivalTime: "25:00" }, String(T1), res, ADMIN
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTeacherFindByIdAndUpdate).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });
});