/**
 * Pay-config + deduction-rule service tests (Phase 2):
 * - Rate changes INSERT a new row (history is never overwritten).
 * - Validation fails closed BEFORE any write (bad teacher/payType/rate/date,
 *   duplicate effective date).
 * - Config list flags teachers without a rate (the UI pill source).
 * - Deduction rule validates type/bounds before the singleton upsert.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockTeacherFindOne = jest.fn();
const mockTeacherFind = jest.fn();
const mockConfigFindOne = jest.fn();
const mockConfigFind = jest.fn();
const mockConfigCreate = jest.fn();
const mockSettingsFindOne = jest.fn();
const mockSettingsUpsert = jest.fn();

jest.mock("../models/Staff/teachers.model", () => ({
  findOne: (...a) => mockTeacherFindOne(...a),
  find: (...a) => mockTeacherFind(...a),
}));
jest.mock("../models/Staff/teacherPayConfig.model", () => ({
  findOne: (...a) => mockConfigFindOne(...a),
  find: (...a) => mockConfigFind(...a),
  create: (...a) => mockConfigCreate(...a),
}));
jest.mock("../models/Staff/teacherSalarySettings.model", () => ({
  findOne: (...a) => mockSettingsFindOne(...a),
  findOneAndUpdate: (...a) => mockSettingsUpsert(...a),
}));

const mongoose = require("mongoose");
const {
  getTeacherPayConfigsService,
  createTeacherPayConfigService,
  getTeacherSalarySettingsService,
  updateTeacherSalarySettingsService,
} = require("../services/staff/teacherSalary.service");

const ADMIN = new mongoose.Types.ObjectId();
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

beforeEach(() => {
  jest.clearAllMocks();
  mockTeacherFindOne.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: T1, name: "Alice", teacherId: "TEA001" }),
  });
  mockConfigFindOne.mockReturnValue(leanChain(null));
  mockConfigCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  mockSettingsFindOne.mockReturnValue(leanChain(null));
});

describe("createTeacherPayConfigService — validation (fail-closed)", () => {
  const valid = { teacher: String(T1), payType: "per-hour", rateAmount: 500, effectiveFrom: "2026-11-01" };

  it.each([
    ["invalid teacher id", { ...valid, teacher: "nope" }],
    ["bad pay type", { ...valid, payType: "monthly" }],
    ["zero rate", { ...valid, rateAmount: 0 }],
    ["negative rate", { ...valid, rateAmount: -5 }],
    ["non-numeric rate", { ...valid, rateAmount: "abc" }],
    ["bad effective date", { ...valid, effectiveFrom: "2026-02-30" }],
  ])("%s → 400 and nothing written", async (_label, body) => {
    const res = mockRes();
    await createTeacherPayConfigService(body, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockConfigCreate).not.toHaveBeenCalled();
  });

  it("withdrawn/unknown teacher → 400 and nothing written", async () => {
    mockTeacherFindOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });
    const res = mockRes();
    await createTeacherPayConfigService(valid, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockConfigCreate).not.toHaveBeenCalled();
  });

  it("duplicate effective date for the same teacher → 400 (history stays unambiguous)", async () => {
    mockConfigFindOne.mockReturnValue(leanChain({ _id: new mongoose.Types.ObjectId() }));
    const res = mockRes();
    await createTeacherPayConfigService(valid, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockConfigCreate).not.toHaveBeenCalled();
  });

  it("valid payload → INSERTS a new row at local midnight with the admin id", async () => {
    const res = mockRes();
    await createTeacherPayConfigService(valid, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockConfigCreate).toHaveBeenCalledTimes(1);
    const doc = mockConfigCreate.mock.calls[0][0];
    expect(doc).toMatchObject({ payType: "per-hour", rateAmount: 500, createdBy: ADMIN });
    expect(doc.effectiveFrom.getDate()).toBe(1);
    expect(doc.effectiveFrom.getMonth()).toBe(10);
    expect(doc.effectiveFrom.getHours()).toBe(0);
  });

  it("rate change inserts ANOTHER row — no update path exists", async () => {
    const res = mockRes();
    await createTeacherPayConfigService({ ...valid, rateAmount: 600, effectiveFrom: "2026-12-01" }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockConfigCreate).toHaveBeenCalledTimes(1);
    expect(mockConfigCreate.mock.calls[0][0].rateAmount).toBe(600);
  });
});

describe("getTeacherPayConfigsService", () => {
  it("flags teachers without a config and reports the newest rate as current", async () => {
    mockTeacherFind.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: T1, name: "Alice", teacherId: "TEA001" },
        { _id: T2, name: "Bob", teacherId: "TEA002" },
      ]),
    });
    mockConfigFind.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { teacher: T1, payType: "per-hour", rateAmount: 600, effectiveFrom: new Date(2026, 10, 1), createdAt: new Date() },
        { teacher: T1, payType: "per-hour", rateAmount: 500, effectiveFrom: new Date(2026, 9, 1), createdAt: new Date() },
      ]),
    });

    const res = mockRes();
    await getTeacherPayConfigsService(res);
    expect(res.status).toHaveBeenCalledWith(200);
    const rows = payload(res).data;
    const alice = rows.find((r) => String(r.teacher) === String(T1));
    const bob = rows.find((r) => String(r.teacher) === String(T2));
    expect(alice.hasConfig).toBe(true);
    expect(alice.current.rateAmount).toBe(600); // newest effective row
    expect(alice.history).toHaveLength(2);
    expect(bob.hasConfig).toBe(false);
    expect(bob.current).toBeNull();
  });
});

describe("salary deduction settings", () => {
  it("no settings doc → disabled defaults", async () => {
    const res = mockRes();
    await getTeacherSalarySettingsService(res);
    expect(payload(res).data).toMatchObject({
      lateDeductionEnabled: false,
      deductionType: "flat",
      flatAmount: 0,
      percentValue: 0,
    });
  });

  it.each([
    ["bad type", { lateDeductionEnabled: true, deductionType: "weekly", flatAmount: 100, percentValue: 0 }],
    ["negative flat", { lateDeductionEnabled: true, deductionType: "flat", flatAmount: -1, percentValue: 0 }],
    ["percent over 100", { lateDeductionEnabled: true, deductionType: "percent", flatAmount: 0, percentValue: 101 }],
    ["non-numeric percent", { lateDeductionEnabled: true, deductionType: "percent", flatAmount: 0, percentValue: "abc" }],
  ])("%s → 400 and nothing written", async (_label, body) => {
    const res = mockRes();
    await updateTeacherSalarySettingsService(body, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSettingsUpsert).not.toHaveBeenCalled();
  });

  it("valid rule → singleton upsert with the admin id", async () => {
    mockSettingsUpsert.mockReturnValue(leanChain({
      lateDeductionEnabled: true, deductionType: "percent", flatAmount: 0, percentValue: 7.5,
    }));
    const res = mockRes();
    await updateTeacherSalarySettingsService(
      { lateDeductionEnabled: true, deductionType: "percent", flatAmount: 0, percentValue: 7.5 }, ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const [filter, update, opts] = mockSettingsUpsert.mock.calls[0];
    expect(filter).toEqual({ key: "default" });
    expect(update.$set).toMatchObject({ lateDeductionEnabled: true, deductionType: "percent", percentValue: 7.5, updatedBy: ADMIN });
    expect(opts).toMatchObject({ upsert: true, new: true });
  });
});