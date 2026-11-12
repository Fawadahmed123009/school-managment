/**
 * Audit hooks — finance paths (expense/income heads + entries, pay config,
 * salary generate/finalize). The audit recorder is mocked so these tests
 * assert WHAT each hook records (action, entity, summary, changed-field
 * snapshots) and that failed validations record NOTHING. The recorder's own
 * fail-open contract is proven in auditLogService.test.js.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

jest.mock("../services/audit/auditLog.service", () => {
  const actual = jest.requireActual("../services/audit/auditLog.service");
  return { ...actual, recordAudit: jest.fn() };
});

const mockExpHeadFindOne = jest.fn();
const mockExpHeadCreate = jest.fn();
const mockExpHeadFindById = jest.fn();
const mockExpHeadFindByIdAndUpdate = jest.fn();
const mockExpEntryCreate = jest.fn();
const mockIncHeadFindOne = jest.fn();
const mockIncHeadCreate = jest.fn();
const mockIncHeadFindById = jest.fn();
const mockIncHeadFindByIdAndUpdate = jest.fn();
const mockIncEntryCreate = jest.fn();
const mockTeacherFindOne = jest.fn();
const mockConfigFind = jest.fn();
const mockConfigFindOne = jest.fn();
const mockConfigCreate = jest.fn();
const mockAttendanceFind = jest.fn();
const mockPhase1FindOne = jest.fn();
const mockSalarySettingsFindOne = jest.fn();
const mockRunFindOne = jest.fn();
const mockRunFindOneAndUpdate = jest.fn();
const mockRunFindById = jest.fn();
const mockRunFind = jest.fn();

jest.mock("../models/Expenses/expenseHead.model", () => ({
  findOne: (...a) => mockExpHeadFindOne(...a),
  create: (...a) => mockExpHeadCreate(...a),
  findById: (...a) => mockExpHeadFindById(...a),
  findByIdAndUpdate: (...a) => mockExpHeadFindByIdAndUpdate(...a),
}));
jest.mock("../models/Expenses/expenseEntry.model", () => ({
  create: (...a) => mockExpEntryCreate(...a),
}));
jest.mock("../models/Income/incomeHead.model", () => ({
  findOne: (...a) => mockIncHeadFindOne(...a),
  create: (...a) => mockIncHeadCreate(...a),
  findById: (...a) => mockIncHeadFindById(...a),
  findByIdAndUpdate: (...a) => mockIncHeadFindByIdAndUpdate(...a),
}));
jest.mock("../models/Income/incomeEntry.model", () => ({
  create: (...a) => mockIncEntryCreate(...a),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  findOne: (...a) => mockTeacherFindOne(...a),
}));
jest.mock("../models/Staff/teacherPayConfig.model", () => ({
  find: (...a) => mockConfigFind(...a),
  findOne: (...a) => mockConfigFindOne(...a),
  create: (...a) => mockConfigCreate(...a),
}));
jest.mock("../models/Staff/teacherAttendance.model", () => ({
  find: (...a) => mockAttendanceFind(...a),
}));
jest.mock("../models/Staff/teacherAttendanceSettings.model", () => ({
  findOne: (...a) => mockPhase1FindOne(...a),
}));
jest.mock("../models/Staff/teacherSalarySettings.model", () => ({
  findOne: (...a) => mockSalarySettingsFindOne(...a),
}));
jest.mock("../models/Staff/teacherSalaryRun.model", () => ({
  findOne: (...a) => mockRunFindOne(...a),
  findOneAndUpdate: (...a) => mockRunFindOneAndUpdate(...a),
  findById: (...a) => mockRunFindById(...a),
  find: (...a) => mockRunFind(...a),
}));

const mongoose = require("mongoose");
const { recordAudit } = require("../services/audit/auditLog.service");
const { createExpenseHeadService, toggleExpenseHeadService } = require("../services/expenses/expenseHead.service");
const { createExpenseEntryService } = require("../services/expenses/expenseEntry.service");
const { createIncomeHeadService, toggleIncomeHeadService } = require("../services/income/incomeHead.service");
const { createIncomeEntryService } = require("../services/income/incomeEntry.service");
const {
  createTeacherPayConfigService,
  generateTeacherSalaryService,
  finalizeTeacherSalaryRunService,
} = require("../services/staff/teacherSalary.service");

const ADMIN = new mongoose.Types.ObjectId();
const HEAD = new mongoose.Types.ObjectId();
const T1 = new mongoose.Types.ObjectId();
const RUN_ID = new mongoose.Types.ObjectId();
const day = (y, m, d) => new Date(y, m - 1, d);

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const leanChain = (doc) => ({ lean: jest.fn().mockResolvedValue(doc) });
const selectLeanChain = (doc) => ({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(doc) });
const lastAudit = () => recordAudit.mock.calls[recordAudit.mock.calls.length - 1][0];

beforeEach(() => {
  jest.clearAllMocks();
  mockExpHeadFindOne.mockResolvedValue(null);
  mockExpHeadCreate.mockImplementation(async (doc) => ({ _id: HEAD, isActive: true, ...doc }));
  mockExpHeadFindById.mockReturnValue(selectLeanChain(null));
  mockExpEntryCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  mockIncHeadFindOne.mockResolvedValue(null);
  mockIncHeadCreate.mockImplementation(async (doc) => ({ _id: HEAD, isActive: true, ...doc }));
  mockIncHeadFindById.mockReturnValue(selectLeanChain(null));
  mockIncEntryCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
});

describe("expense head hooks", () => {
  it("create → create/expense_head with the name snapshot", async () => {
    const res = mockRes();
    await createExpenseHeadService({ name: "Printing" }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({
      userId: ADMIN,
      actionType: "create",
      entityType: "expense_head",
      summary: 'Created expense head "Printing"',
      afterSnapshot: { name: "Printing", isActive: true },
    });
  });

  it("duplicate name → 409 and NO audit row", async () => {
    mockExpHeadFindOne.mockResolvedValue({ _id: HEAD, name: "Printing" });
    const res = mockRes();
    await createExpenseHeadService({ name: "printing" }, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("deactivate → deactivate with before/after isActive only", async () => {
    mockExpHeadFindById.mockReturnValue(selectLeanChain({ _id: HEAD, name: "Printing", isActive: true }));
    mockExpHeadFindByIdAndUpdate.mockResolvedValue({ _id: HEAD, name: "Printing", isActive: false });
    const res = mockRes();
    await toggleExpenseHeadService(String(HEAD), false, res, ADMIN);
    expect(lastAudit()).toMatchObject({
      userId: ADMIN,
      actionType: "deactivate",
      entityType: "expense_head",
      beforeSnapshot: { isActive: true },
      afterSnapshot: { isActive: false },
    });
    expect(lastAudit().summary).toBe('Deactivated expense head "Printing"');
  });

  it("reactivate → activate", async () => {
    mockExpHeadFindById.mockReturnValue(selectLeanChain({ _id: HEAD, name: "Printing", isActive: false }));
    mockExpHeadFindByIdAndUpdate.mockResolvedValue({ _id: HEAD, name: "Printing", isActive: true });
    const res = mockRes();
    await toggleExpenseHeadService(String(HEAD), true, res, ADMIN);
    expect(lastAudit().actionType).toBe("activate");
  });

  it("no-op toggle (already in target state) → NO audit row", async () => {
    mockExpHeadFindById.mockReturnValue(selectLeanChain({ _id: HEAD, name: "Printing", isActive: true }));
    mockExpHeadFindByIdAndUpdate.mockResolvedValue({ _id: HEAD, name: "Printing", isActive: true });
    const res = mockRes();
    await toggleExpenseHeadService(String(HEAD), true, res, ADMIN);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("expense entry hook", () => {
  const valid = {
    expenseHead: String(HEAD),
    date: "2026-11-15",
    itemName: "A4 paper ream",
    quantity: 2.5,
    unitRate: 45.5,
  };

  it("create → create/expense_entry with the recomputed total in the snapshot", async () => {
    mockExpHeadFindById.mockReturnValue(selectLeanChain({ _id: HEAD, name: "Printing", isActive: true }));
    const res = mockRes();
    await createExpenseEntryService(valid, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const entry = lastAudit();
    expect(entry).toMatchObject({ userId: ADMIN, actionType: "create", entityType: "expense_entry" });
    expect(entry.afterSnapshot).toMatchObject({ expenseHead: "Printing", itemName: "A4 paper ream", totalAmount: 113.75 });
    expect(entry.summary).toContain("Recorded expense");
    expect(entry.summary).toContain("113.75");
  });

  it("inactive head → 400 and NO audit row", async () => {
    mockExpHeadFindById.mockReturnValue(selectLeanChain({ _id: HEAD, name: "Printing", isActive: false }));
    const res = mockRes();
    await createExpenseEntryService(valid, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("income head + entry hooks", () => {
  it("head create → create/income_head", async () => {
    const res = mockRes();
    await createIncomeHeadService({ name: "Donation" }, ADMIN, res);
    expect(lastAudit()).toMatchObject({ actionType: "create", entityType: "income_head", userId: ADMIN });
  });

  it("head deactivate → deactivate/income_head with the diff", async () => {
    mockIncHeadFindById.mockReturnValue(selectLeanChain({ _id: HEAD, name: "Donation", isActive: true }));
    mockIncHeadFindByIdAndUpdate.mockResolvedValue({ _id: HEAD, name: "Donation", isActive: false });
    const res = mockRes();
    await toggleIncomeHeadService(String(HEAD), false, res, ADMIN);
    expect(lastAudit()).toMatchObject({
      actionType: "deactivate",
      entityType: "income_head",
      beforeSnapshot: { isActive: true },
      afterSnapshot: { isActive: false },
    });
  });

  it("entry create (quantity mode) → snapshot carries qty/rate/total", async () => {
    mockIncHeadFindById.mockReturnValue(selectLeanChain({ _id: HEAD, name: "Notes Sale", isActive: true }));
    const res = mockRes();
    await createIncomeEntryService(
      { incomeHead: String(HEAD), date: "2026-11-15", description: "Notebook set", quantity: 3, unitRate: 100 },
      ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(lastAudit()).toMatchObject({ actionType: "create", entityType: "income_entry" });
    expect(lastAudit().afterSnapshot).toMatchObject({ quantity: 3, unitRate: 100, totalAmount: 300 });
  });

  it("entry create (direct mode) → snapshot has total only, no qty/rate", async () => {
    mockIncHeadFindById.mockReturnValue(selectLeanChain({ _id: HEAD, name: "Donation", isActive: true }));
    const res = mockRes();
    await createIncomeEntryService(
      { incomeHead: String(HEAD), date: "2026-11-15", description: "Lump donation", totalAmount: 5000 },
      ADMIN, res
    );
    const snap = lastAudit().afterSnapshot;
    expect(snap.totalAmount).toBe(5000);
    expect(snap.quantity).toBeUndefined();
    expect(snap.unitRate).toBeUndefined();
  });
});

// ── salary (Phase 2 harness, same shapes as teacherSalaryRuns.test.js) ──────

function setupSalaryHappyPath() {
  mockTeacherFindOne.mockReturnValue(selectLeanChain({ _id: T1, name: "Alice", teacherId: "TEA001" }));
  mockConfigFind.mockReturnValue(leanChain([
    { teacher: T1, payType: "per-hour", rateAmount: 500, effectiveFrom: day(2026, 10, 1) },
  ]));
  mockConfigFindOne.mockReturnValue(leanChain(null));
  mockAttendanceFind.mockReturnValue(leanChain([
    { teacher: T1, date: day(2026, 11, 4), arrivalTime: "08:00", departureTime: "16:00", workingMinutes: 480, isLate: false },
  ]));
  mockPhase1FindOne.mockReturnValue(leanChain({ lateDetectionEnabled: true }));
  mockSalarySettingsFindOne.mockReturnValue(leanChain(null));
  mockRunFindOne.mockReturnValue(selectLeanChain(null)); // no draft being replaced
  mockRunFind.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  });
}
const RANGE = { teacherId: String(T1), startDate: "2026-11-04", endDate: "2026-11-04" };

describe("pay config hook", () => {
  it("create → create/pay_config with rate + effective date (insert-only history)", async () => {
    setupSalaryHappyPath();
    mockConfigCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
    const res = mockRes();
    await createTeacherPayConfigService(
      { teacher: String(T1), payType: "per-hour", rateAmount: 500, effectiveFrom: "2026-11-01" },
      ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    const entry = lastAudit();
    expect(entry).toMatchObject({ userId: ADMIN, actionType: "create", entityType: "pay_config" });
    expect(entry.summary).toContain("Alice");
    expect(entry.summary).toContain("500");
    expect(entry.afterSnapshot).toMatchObject({ payType: "per-hour", rateAmount: 500, effectiveFrom: "2026-11-01" });
  });

  it("clashing effective date → 400 and NO audit row", async () => {
    setupSalaryHappyPath();
    mockConfigFindOne.mockReturnValue(leanChain({ _id: new mongoose.Types.ObjectId() }));
    const res = mockRes();
    await createTeacherPayConfigService(
      { teacher: String(T1), payType: "per-hour", rateAmount: 500, effectiveFrom: "2026-11-01" },
      ADMIN, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe("salary run hooks", () => {
  it("generate (fresh) → generate/salary_run with the run totals snapshot", async () => {
    setupSalaryHappyPath();
    mockRunFindOneAndUpdate.mockReturnValue(leanChain({
      _id: RUN_ID, status: "draft", grossAmount: 4000, lateDeductionAmount: 0, netAmount: 4000,
      totalWorkingDays: 1, totalWorkingHours: 8, lateDays: 0, lectureCount: 0,
    }));
    const res = mockRes();
    await generateTeacherSalaryService(RANGE, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);
    const entry = lastAudit();
    expect(entry).toMatchObject({ userId: ADMIN, actionType: "generate", entityType: "salary_run", entityId: RUN_ID });
    expect(entry.summary).toContain("Generated salary run for Alice");
    expect(entry.summary).toContain("4,000");
    expect(entry.beforeSnapshot).toBeNull();
    expect(entry.afterSnapshot).toMatchObject({ netAmount: 4000, status: "draft" });
  });

  it("generate (replacing a draft) → before/after hold ONLY the changed totals", async () => {
    setupSalaryHappyPath();
    mockRunFindOne.mockReturnValue(selectLeanChain({
      status: "draft", grossAmount: 3500, lateDeductionAmount: 0, netAmount: 3500,
      totalWorkingDays: 1, totalWorkingHours: 7, lateDays: 0, lectureCount: 0,
    }));
    mockRunFindOneAndUpdate.mockReturnValue(leanChain({
      _id: RUN_ID, status: "draft", grossAmount: 4000, lateDeductionAmount: 0, netAmount: 4000,
      totalWorkingDays: 1, totalWorkingHours: 8, lateDays: 0, lectureCount: 0,
    }));
    const res = mockRes();
    await generateTeacherSalaryService(RANGE, ADMIN, res);
    const entry = lastAudit();
    expect(entry.summary).toContain("Regenerated");
    expect(entry.beforeSnapshot).toEqual({ grossAmount: 3500, netAmount: 3500, totalWorkingHours: 7 });
    expect(entry.afterSnapshot).toEqual({ grossAmount: 4000, netAmount: 4000, totalWorkingHours: 8 });
  });

  it("no pay config → 400 and NO audit row", async () => {
    setupSalaryHappyPath();
    mockConfigFind.mockReturnValue(leanChain([]));
    const res = mockRes();
    await generateTeacherSalaryService(RANGE, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("finalize → finalize/salary_run, draft→finalized diff, {teacher} deferred", async () => {
    const finalizedAt = new Date();
    mockRunFindOneAndUpdate.mockReturnValue(leanChain({
      _id: RUN_ID, teacher: T1, status: "finalized", finalizedAt,
      periodStart: day(2026, 11, 1), periodEnd: day(2026, 11, 30), netAmount: 90000,
    }));
    const res = mockRes();
    await finalizeTeacherSalaryRunService(String(RUN_ID), ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const entry = lastAudit();
    expect(entry).toMatchObject({
      userId: ADMIN,
      actionType: "finalize",
      entityType: "salary_run",
      entityId: RUN_ID,
      teacherId: T1,
      beforeSnapshot: { status: "draft" },
    });
    expect(entry.afterSnapshot).toEqual({ status: "finalized", finalizedAt });
    expect(entry.summary).toContain("Finalized salary run for {teacher}");
    expect(entry.summary).toContain("1 Nov 2026");
    expect(entry.summary).toContain("30 Nov 2026");
  });

  it("finalizing a non-draft → 400 and NO audit row", async () => {
    mockRunFindOneAndUpdate.mockReturnValue(leanChain(null));
    mockRunFindById.mockReturnValue(selectLeanChain({ status: "finalized" }));
    const res = mockRes();
    await finalizeTeacherSalaryRunService(String(RUN_ID), ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(recordAudit).not.toHaveBeenCalled();
  });
});