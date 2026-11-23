/**
 * Salary run lifecycle tests (Phase 2):
 * - Preview is a DRY RUN: full calculation, zero writes.
 * - Generate recomputes server-side and upserts ONLY the same-period draft.
 * - Fail-closed: no pay config / bad range / bad override → 400, no writes.
 * - Finalize locks a draft; finalized runs can't be re-finalized or deleted.
 * - Lump-sum runs store the configured amount as gross — attendance in the
 *   snapshot is informational only.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockTeacherFindOne = jest.fn();
const mockConfigFind = jest.fn();
const mockAttendanceFind = jest.fn();
const mockPhase1FindOne = jest.fn();
const mockSalarySettingsFindOne = jest.fn();
const mockRunFindOne = jest.fn();
const mockRunFindOneAndUpdate = jest.fn();
const mockRunFindById = jest.fn();
const mockRunFindOneAndDelete = jest.fn();
const mockRunFind = jest.fn();

jest.mock("../models/Staff/teachers.model", () => ({
  findOne: (...a) => mockTeacherFindOne(...a),
}));
jest.mock("../models/Staff/teacherPayConfig.model", () => ({
  find: (...a) => mockConfigFind(...a),
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
  find: (...a) => mockRunFind(...a),
  findOne: (...a) => mockRunFindOne(...a),
  findOneAndUpdate: (...a) => mockRunFindOneAndUpdate(...a),
  findById: (...a) => mockRunFindById(...a),
  findOneAndDelete: (...a) => mockRunFindOneAndDelete(...a),
}));

const mongoose = require("mongoose");
const {
  previewTeacherSalaryService,
  generateTeacherSalaryService,
  getTeacherSalaryRunsService,
  finalizeTeacherSalaryRunService,
  deleteTeacherSalaryRunService,
} = require("../services/staff/teacherSalary.service");

const ADMIN = new mongoose.Types.ObjectId();
const T1 = new mongoose.Types.ObjectId();
const RUN_ID = new mongoose.Types.ObjectId();
const day = (y, m, d) => new Date(y, m - 1, d);

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];
const leanChain = (doc) => ({ lean: jest.fn().mockResolvedValue(doc) });

// One per-hour teacher at Rs 500/h, one 8h day inside the range.
function setupHappyPath() {
  mockTeacherFindOne.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: T1, name: "Alice", teacherId: "TEA001" }),
  });
  mockConfigFind.mockReturnValue(leanChain([
    { teacher: T1, payType: "per-hour", rateAmount: 500, effectiveFrom: day(2026, 10, 1) },
  ]));
  mockAttendanceFind.mockReturnValue(leanChain([
    { teacher: T1, date: day(2026, 11, 4), arrivalTime: "08:00", departureTime: "16:00", workingMinutes: 480, isLate: false },
  ]));
  mockPhase1FindOne.mockReturnValue(leanChain({ lateDetectionEnabled: true }));
  mockSalarySettingsFindOne.mockReturnValue(leanChain(null)); // deductions off
  mockRunFindOne.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(null),
  });
  mockRunFind.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  });
}

const RANGE = { teacherId: String(T1), startDate: "2026-11-04", endDate: "2026-11-04" };

beforeEach(() => {
  jest.clearAllMocks();
  setupHappyPath();
});

describe("preview — dry run", () => {
  it("computes the full payload and writes NOTHING", async () => {
    const res = mockRes();
    await previewTeacherSalaryService(RANGE, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const data = payload(res).data;
    expect(data.grossAmount).toBe(4000); // 8h × 500
    expect(data.netAmount).toBe(4000);
    expect(data.totalWorkingDays).toBe(1);
    expect(data.teacher.name).toBe("Alice");
    expect(mockRunFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockRunFindOneAndDelete).not.toHaveBeenCalled();
  });

  it("queries attendance with an INCLUSIVE exact range (4th → 4th)", async () => {
    const res = mockRes();
    await previewTeacherSalaryService(RANGE, res);
    const match = mockAttendanceFind.mock.calls[0][0];
    expect(match.date.$gte).toEqual(day(2026, 11, 4));
    expect(match.date.$lt).toEqual(day(2026, 11, 5)); // end + 1 day
  });

  it.each([
    ["bad start", { ...RANGE, startDate: "2026-02-30" }],
    ["bad end", { ...RANGE, endDate: "nope" }],
    ["reversed range", { ...RANGE, startDate: "2026-11-05", endDate: "2026-11-04" }],
    ["bad teacher id", { ...RANGE, teacherId: "xyz" }],
    ["fractional lecture override", { ...RANGE, lectureCount: 2.5 }],
    ["negative lecture override", { ...RANGE, lectureCount: -1 }],
  ])("%s → 400 and no run write", async (_label, body) => {
    const res = mockRes();
    await previewTeacherSalaryService(body, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockRunFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("teacher with NO pay config → clear 400, never a silent Rs 0", async () => {
    mockConfigFind.mockReturnValue(leanChain([]));
    const res = mockRes();
    await previewTeacherSalaryService(RANGE, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(payload(res).message).toMatch(/Pay rate not set/);
    expect(mockRunFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("withdrawn teacher → 400", async () => {
    mockTeacherFindOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });
    const res = mockRes();
    await previewTeacherSalaryService(RANGE, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("reports an existing same-period draft and finalized overlaps", async () => {
    mockRunFindOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ _id: RUN_ID }),
    });
    // findFinalizedOverlaps uses TeacherSalaryRun.find(...).select().sort().lean()
    mockRunFind.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: new mongoose.Types.ObjectId(), periodStart: day(2026, 11, 1), periodEnd: day(2026, 11, 30), netAmount: 90000 }]),
    });
    const res = mockRes();
    await previewTeacherSalaryService(RANGE, res);
    const data = payload(res).data;
    expect(String(data.replacesDraftId)).toBe(String(RUN_ID));
    expect(data.overlaps).toHaveLength(1);
  });
});

describe("generate — server-side recompute + draft replace", () => {
  it("upserts ONLY the same teacher+period DRAFT with recomputed amounts", async () => {
    mockRunFindOneAndUpdate.mockReturnValue(leanChain({ _id: RUN_ID, status: "draft", grossAmount: 4000, netAmount: 4000 }));
    const res = mockRes();
    await generateTeacherSalaryService(RANGE, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const [filter, update, opts] = mockRunFindOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ status: "draft", periodStart: day(2026, 11, 4), periodEnd: day(2026, 11, 4) });
    expect(String(filter.teacher)).toBe(String(T1));
    expect(update.$set.grossAmount).toBe(4000);
    expect(update.$set.netAmount).toBe(4000);
    expect(update.$set.generatedBy).toEqual(ADMIN);
    expect(update.$setOnInsert).toEqual({ status: "draft" });
    expect(opts).toMatchObject({ upsert: true, new: true });
  });

  it("client-supplied amounts are ignored — only ids/dates/override are read", async () => {
    mockRunFindOneAndUpdate.mockReturnValue(leanChain({ _id: RUN_ID, status: "draft" }));
    const res = mockRes();
    await generateTeacherSalaryService({ ...RANGE, grossAmount: 1, netAmount: 999999 }, ADMIN, res);
    const update = mockRunFindOneAndUpdate.mock.calls[0][1];
    expect(update.$set.grossAmount).toBe(4000); // recomputed, not the injected 1
    expect(update.$set.netAmount).toBe(4000);
  });

  it("no pay config → 400 and nothing written", async () => {
    mockConfigFind.mockReturnValue(leanChain([]));
    const res = mockRes();
    await generateTeacherSalaryService(RANGE, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockRunFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

/* ── lump sum through the run lifecycle ─────────────────────────────────────
 * The configured amount IS the pay: attendance rows are still read and stored
 * for the snapshot, but they never move gross, and a lecture override has no
 * effect on a lump-sum teacher.
 */
describe("lump sum — preview and generate", () => {
  const MONTH = { teacherId: String(T1), startDate: "2026-11-01", endDate: "2026-11-30" };
  const dayRow = (d, isLate = false) => ({
    teacher: T1, date: day(2026, 11, d), arrivalTime: "08:00",
    departureTime: "16:00", workingMinutes: 480, isLate,
  });

  // Replace the per-hour happy-path config with a Rs 30 000 lump sum.
  const asLumpTeacher = (records) => {
    mockConfigFind.mockReturnValue(leanChain([
      { teacher: T1, payType: "lump-sum", rateAmount: 30000, effectiveFrom: day(2026, 10, 1) },
    ]));
    mockAttendanceFind.mockReturnValue(leanChain(records));
  };

  it("preview pays the amount in full and writes NOTHING", async () => {
    asLumpTeacher([dayRow(4)]);
    const res = mockRes();
    await previewTeacherSalaryService(MONTH, res);
    const data = payload(res).data;
    expect(data.payType).toBe("lump-sum");
    expect(data.grossAmount).toBe(30000);
    expect(data.netAmount).toBe(30000);
    // Attendance is REPORTED next to the amount, it is not paid.
    expect(data.totalWorkingDays).toBe(1);
    expect(data.segments[0]).toMatchObject({ rateAmount: 30000, periodDays: 30, amount: 30000 });
    expect(mockRunFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("zero attendance still pays the amount (unlike per-hour, which would pay Rs 0)", async () => {
    asLumpTeacher([]);
    const res = mockRes();
    await previewTeacherSalaryService(MONTH, res);
    const data = payload(res).data;
    expect(data.totalWorkingDays).toBe(0);
    expect(data.grossAmount).toBe(30000);
  });

  it("a lecture override cannot change a lump-sum gross", async () => {
    asLumpTeacher([dayRow(4)]);
    const res = mockRes();
    await previewTeacherSalaryService({ ...MONTH, lectureCount: 999 }, res);
    const data = payload(res).data;
    expect(data.lectureCount).toBe(0);
    expect(data.lectureOverridden).toBe(false);
    expect(data.grossAmount).toBe(30000);
  });

  it("a late deduction still comes off the lump gross when the rule is on", async () => {
    asLumpTeacher([dayRow(4, true), dayRow(5, true)]);
    mockSalarySettingsFindOne.mockReturnValue(
      leanChain({ lateDeductionEnabled: true, deductionType: "flat", flatAmount: 200, percentValue: 0 })
    );
    const res = mockRes();
    await previewTeacherSalaryService(MONTH, res);
    const data = payload(res).data;
    expect(data.lateDays).toBe(2);
    expect(data.grossAmount).toBe(30000);
    expect(data.lateDeductionAmount).toBe(400);
    expect(data.netAmount).toBe(29600);
  });

  it("generate snapshots the pay type, the amount and the segment day split", async () => {
    asLumpTeacher([dayRow(4)]);
    mockRunFindOneAndUpdate.mockReturnValue(leanChain({ _id: RUN_ID, status: "draft" }));
    const res = mockRes();
    await generateTeacherSalaryService(MONTH, ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(201);

    const [filter, update] = mockRunFindOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({
      status: "draft", periodStart: day(2026, 11, 1), periodEnd: day(2026, 11, 30),
    });
    expect(update.$set.payType).toBe("lump-sum");
    expect(update.$set.grossAmount).toBe(30000);
    expect(update.$set.netAmount).toBe(30000);
    expect(update.$set.segments[0]).toMatchObject({ rateAmount: 30000, periodDays: 30, amount: 30000 });
  });

  it("client-supplied amounts are ignored for a lump-sum run too", async () => {
    asLumpTeacher([dayRow(4)]);
    mockRunFindOneAndUpdate.mockReturnValue(leanChain({ _id: RUN_ID, status: "draft" }));
    const res = mockRes();
    await generateTeacherSalaryService({ ...MONTH, grossAmount: 1, netAmount: 999999 }, ADMIN, res);
    const update = mockRunFindOneAndUpdate.mock.calls[0][1];
    expect(update.$set.grossAmount).toBe(30000); // the configured amount, not the injected 1
    expect(update.$set.netAmount).toBe(30000);
  });
});

describe("finalize — lock the draft", () => {
  it("draft → finalized with actor + timestamp", async () => {
    mockRunFindOneAndUpdate.mockReturnValue(leanChain({ _id: RUN_ID, status: "finalized" }));
    const res = mockRes();
    await finalizeTeacherSalaryRunService(String(RUN_ID), ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const [filter, update] = mockRunFindOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: String(RUN_ID), status: "draft" });
    expect(update.$set.status).toBe("finalized");
    expect(update.$set.finalizedBy).toEqual(ADMIN);
    expect(update.$set.finalizedAt).toBeInstanceOf(Date);
  });

  it("already finalized → 400 (immutable)", async () => {
    mockRunFindOneAndUpdate.mockReturnValue(leanChain(null));
    mockRunFindById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ status: "finalized" }),
    });
    const res = mockRes();
    await finalizeTeacherSalaryRunService(String(RUN_ID), ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("missing run → 404", async () => {
    mockRunFindOneAndUpdate.mockReturnValue(leanChain(null));
    mockRunFindById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });
    const res = mockRes();
    await finalizeTeacherSalaryRunService(String(RUN_ID), ADMIN, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe("delete — drafts only", () => {
  it("deletes a draft", async () => {
    mockRunFindOneAndDelete.mockReturnValue(leanChain({ _id: RUN_ID, status: "draft" }));
    const res = mockRes();
    await deleteTeacherSalaryRunService(String(RUN_ID), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockRunFindOneAndDelete.mock.calls[0][0]).toMatchObject({ _id: String(RUN_ID), status: "draft" });
  });

  it("finalized run → 400, never deleted", async () => {
    mockRunFindOneAndDelete.mockReturnValue(leanChain(null));
    mockRunFindById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ status: "finalized" }),
    });
    const res = mockRes();
    await deleteTeacherSalaryRunService(String(RUN_ID), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("run list filters", () => {
  it.each([
    ["invalid teacher id", { teacherId: "xyz" }],
    ["invalid status", { status: "paid" }],
  ])("%s → 400", async (_label, filters) => {
    const res = mockRes();
    await getTeacherSalaryRunsService(filters, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});