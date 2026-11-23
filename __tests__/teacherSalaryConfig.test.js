/**
 * Pay-config + deduction-rule service tests (Phase 2):
 * - Rate changes INSERT a new row (history is never overwritten).
 * - Validation fails closed BEFORE any write (bad teacher/payType/rate/date,
 *   duplicate effective date).
 * - Config list flags teachers without a rate (the UI pill source).
 * - Deduction rule validates type/bounds before the singleton upsert.
 * - Lump sum is the THIRD pay mode: the amount is stored as-is (never a rate),
 *   validated by the same positive-amount rule and audited with its own label.
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

// The real recorder is fail-open and skips without a DB connection, so it is
// mocked here to assert WHAT each pay mode records (formatMoney/formatDay stay
// real). Same pattern as __tests__/auditLogFinanceHooks.test.js.
jest.mock("../services/audit/auditLog.service", () => {
  const actual = jest.requireActual("../services/audit/auditLog.service");
  return { ...actual, recordAudit: jest.fn() };
});

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
const { recordAudit } = require("../services/audit/auditLog.service");
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

/* ── lump sum: the third pay mode ───────────────────────────────────────────
 * The admin picks "Lump sum" and enters ONE amount. It is stored verbatim in
 * rateAmount (one field keeps the insert-only history and every run snapshot
 * uniform) and validated by exactly the same positive-amount rule as a rate.
 */
describe("createTeacherPayConfigService — lump sum", () => {
  const lump = { teacher: String(T1), payType: "lump-sum", rateAmount: 30000, effectiveFrom: "2026-11-01" };

  it("lump-sum is a valid pay type → the amount is inserted as a new history row", async () => {
    const res = mockRes();
    await createTeacherPayConfigService(lump, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockConfigCreate).toHaveBeenCalledTimes(1);
    const doc = mockConfigCreate.mock.calls[0][0];
    expect(doc).toMatchObject({ payType: "lump-sum", rateAmount: 30000, createdBy: ADMIN });
    expect(doc.effectiveFrom.getDate()).toBe(1);
  });

  it.each([[0], [-30000], ["abc"]])("amount %p → 400 and nothing written", async (rateAmount) => {
    const res = mockRes();
    await createTeacherPayConfigService({ ...lump, rateAmount }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockConfigCreate).not.toHaveBeenCalled();
  });

  it("a fourth mode is still refused, by name, and nothing is written", async () => {
    const res = mockRes();
    await createTeacherPayConfigService({ ...lump, payType: "weekly" }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payload(res).message).toMatch(/per-hour, per-lecture or lump-sum/);
    expect(mockConfigCreate).not.toHaveBeenCalled();
  });

  it("switching an existing per-hour teacher to lump sum INSERTS — the old row is untouched", async () => {
    const res = mockRes();
    await createTeacherPayConfigService({ ...lump, effectiveFrom: "2026-12-01" }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    // The history collection is written through create() only.
    expect(mockConfigCreate).toHaveBeenCalledTimes(1);
    expect(mockConfigCreate.mock.calls[0][0].payType).toBe("lump-sum");
  });
});

describe("createTeacherPayConfigService — audit summary per pay mode", () => {
  it.each([
    ["per-hour", 500, /Rs 500\/hour effective/],
    ["per-lecture", 700, /Rs 700\/lecture effective/],
    ["lump-sum", 30000, /Rs 30,?000 lump sum effective/],
  ])("%s records the amount with its own unit label", async (payType, rateAmount, re) => {
    const res = mockRes();
    await createTeacherPayConfigService(
      { teacher: String(T1), payType, rateAmount, effectiveFrom: "2026-11-01" }, ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    const entry = recordAudit.mock.calls[0][0];
    expect(entry).toMatchObject({ actionType: "create", entityType: "pay_config", userId: ADMIN });
    expect(entry.summary).toMatch(re);
    expect(entry.summary).toMatch(/Alice/);
    expect(entry.afterSnapshot.payType).toBe(payType);
  });

  it("a refused write records nothing (validation fails before the audit)", async () => {
    const res = mockRes();
    await createTeacherPayConfigService(
      { teacher: String(T1), payType: "lump-sum", rateAmount: 0, effectiveFrom: "2026-11-01" }, ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("pay-mode schema — lump sum is a first-class enum value", () => {
  // Real (unmocked) schemas, so the enum + min rules themselves are exercised.
  const RealPayConfig = jest.requireActual("../models/Staff/teacherPayConfig.model");
  const RealSalaryRun = jest.requireActual("../models/Staff/teacherSalaryRun.model");
  const base = () => ({
    teacher: new mongoose.Types.ObjectId(),
    payType: "lump-sum",
    rateAmount: 30000,
    effectiveFrom: new Date(2026, 10, 1),
    createdBy: ADMIN,
  });

  it.each(["per-hour", "per-lecture", "lump-sum"])("%s config validates", (payType) => {
    expect(new RealPayConfig({ ...base(), payType }).validateSync()).toBeUndefined();
  });

  it("a pay type outside the three modes is rejected by the schema too", () => {
    const err = new RealPayConfig({ ...base(), payType: "weekly" }).validateSync();
    expect(err).toBeTruthy();
    expect(err.errors.payType).toBeTruthy();
  });

  it("a zero amount is rejected (a silent Rs 0 run is forbidden)", () => {
    const err = new RealPayConfig({ ...base(), rateAmount: 0 }).validateSync();
    expect(err).toBeTruthy();
    expect(err.errors.rateAmount).toBeTruthy();
  });

  it("a lump-sum run snapshot stores the amount and its periodDays split", () => {
    const run = new RealSalaryRun({
      teacher: new mongoose.Types.ObjectId(),
      periodStart: new Date(2026, 10, 1),
      periodEnd: new Date(2026, 10, 30),
      totalWorkingDays: 2,
      totalWorkingHours: 16,
      grossAmount: 32500,
      netAmount: 32500,
      payType: "lump-sum",
      generatedBy: ADMIN,
      segments: [
        { effectiveFrom: new Date(2026, 10, 1), rateAmount: 30000, days: 1, hours: 8, lectures: 0, periodDays: 15, amount: 15000 },
        { effectiveFrom: new Date(2026, 10, 16), rateAmount: 35000, days: 1, hours: 8, lectures: 0, periodDays: 15, amount: 17500 },
      ],
    });
    expect(run.validateSync()).toBeUndefined();
    expect(run.segments[0].periodDays).toBe(15);
  });
});