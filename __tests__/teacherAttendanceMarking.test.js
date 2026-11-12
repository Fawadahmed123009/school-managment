/**
 * Marking-path tests for teacher attendance (Phase 1):
 * - Fail-closed validation: nothing is written when any row is invalid
 *   (bad date/times, departure ≤ arrival, duplicate/unknown/withdrawn teacher).
 * - workingMinutes derived from arrival/departure; upsert on {teacher, date}
 *   with createdBy set only on insert.
 * - Late flag judged against each teacher's OWN expected arrival time from
 *   the staff profile + admin grace; no expectation → never late.
 * - Day roster merges existing records and excludes withdrawn teachers.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockTeacherFind = jest.fn();
const mockTaFindOneAndUpdate = jest.fn();
const mockTaFind = jest.fn();
const mockSettingsFindOne = jest.fn();

jest.mock("../models/Staff/teachers.model", () => ({
  find: (...a) => mockTeacherFind(...a),
}));
jest.mock("../models/Staff/teacherAttendance.model", () => ({
  findOneAndUpdate: (...a) => mockTaFindOneAndUpdate(...a),
  find: (...a) => mockTaFind(...a),
}));
jest.mock("../models/Staff/teacherAttendanceSettings.model", () => ({
  findOne: (...a) => mockSettingsFindOne(...a),
}));

const mongoose = require("mongoose");
const {
  markTeacherAttendanceService,
  getTeacherAttendanceDayService,
} = require("../services/staff/teacherAttendance.service");

const T1 = new mongoose.Types.ObjectId();
const T2 = new mongoose.Types.ObjectId();
const MARKER = new mongoose.Types.ObjectId();

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];

function teacherChain(docs) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(docs),
  };
}
const leanChain = (docs) => ({ lean: jest.fn().mockResolvedValue(docs) });

// Default: both teachers active (T1's profile expects 08:00, T2 has no
// expectation → late detection skipped for them), no settings doc (late
// detection disabled), no existing rows for the marking merge query.
function setupDefaults() {
  mockTeacherFind.mockReturnValue(teacherChain([
    { _id: T1, expectedArrivalTime: "08:00" },
    { _id: T2 },
  ]));
  mockSettingsFindOne.mockReturnValue(leanChain(null));
  mockTaFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  mockTaFindOneAndUpdate.mockImplementation(async (filter, update) => ({
    _id: new mongoose.Types.ObjectId(),
    ...update.$set,
    ...(update.$setOnInsert || {}),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  setupDefaults();
});

const goodRecords = [
  { teacher: T1.toString(), arrivalTime: "08:00", departureTime: "15:30" },
  { teacher: T2.toString(), arrivalTime: "08:05", departureTime: "14:05" },
];

describe("markTeacherAttendanceService — happy path", () => {
  it("upserts each row with derived workingMinutes and audit fields", async () => {
    const res = mockRes();
    await markTeacherAttendanceService("2026-11-10", goodRecords, MARKER, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockTaFindOneAndUpdate).toHaveBeenCalledTimes(2);

    const [filter, update, opts] = mockTaFindOneAndUpdate.mock.calls[0];
    expect(filter.teacher).toBe(T1.toString());
    // Date bucketed at LOCAL midnight (student-attendance convention)
    expect(filter.date).toEqual(new Date(2026, 10, 10));
    expect(filter.date.getHours()).toBe(0);
    expect(update.$set.workingMinutes).toBe(450);
    expect(update.$set.isLate).toBe(false);
    expect(update.$set.lateMinutes).toBe(0);
    expect(update.$set.updatedBy).toBe(MARKER);
    // A manager/admin save is an explicit correction → manual provenance.
    expect(update.$set.arrivalSource).toBe("manual");
    expect(update.$set.departureSource).toBe("manual");
    expect(update.$setOnInsert.createdBy).toBe(MARKER);
    expect(opts).toMatchObject({ upsert: true, new: true });

    // Second row: 08:05 → 14:05 = 360 minutes
    expect(mockTaFindOneAndUpdate.mock.calls[1][1].$set.workingMinutes).toBe(360);
  });

  it("derives the late flag from the teacher's expected arrival + grace", async () => {
    mockSettingsFindOne.mockReturnValue(leanChain({
      lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10,
    }));
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: T1.toString(), arrivalTime: "08:35", departureTime: "15:00" }],
      MARKER, res
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const set = mockTaFindOneAndUpdate.mock.calls[0][1].$set;
    expect(set.isLate).toBe(true);
    expect(set.lateMinutes).toBe(25); // 08:35 vs T1's 08:00 + 10 threshold
  });

  it("enabled rule but NO expected arrival on the profile → never late", async () => {
    mockSettingsFindOne.mockReturnValue(leanChain({
      lateDetectionEnabled: true, startTime: "07:00", graceMinutes: 0,
    }));
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: T2.toString(), arrivalTime: "12:00", departureTime: "15:00" }],
      MARKER, res
    );

    // T2 has no profile expectation → skipped, NOT judged against the
    // global startTime (no false positives).
    const set = mockTaFindOneAndUpdate.mock.calls[0][1].$set;
    expect(set.isLate).toBe(false);
    expect(set.lateMinutes).toBe(0);
  });

  it("disabled rule → late arrival stays unflagged (default until admin enables)", async () => {
    mockSettingsFindOne.mockReturnValue(leanChain({
      lateDetectionEnabled: false, startTime: "08:00", graceMinutes: 10,
    }));
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: T1.toString(), arrivalTime: "12:00", departureTime: "15:00" }],
      MARKER, res
    );
    const set = mockTaFindOneAndUpdate.mock.calls[0][1].$set;
    expect(set.isLate).toBe(false);
    expect(set.lateMinutes).toBe(0);
  });
});

describe("markTeacherAttendanceService — fail-closed validation", () => {
  it.each([
    ["empty records", "2026-11-10", []],
    ["missing records", "2026-11-10", null],
    ["bad date", "10-11-2026", goodRecords],
    ["impossible date", "2026-02-30", goodRecords],
  ])("%s → 400 and nothing written", async (_label, date, records) => {
    const res = mockRes();
    await markTeacherAttendanceService(date, records, MARKER, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("invalid time format → 400, nothing written", async () => {
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: T1.toString(), arrivalTime: "8:00", departureTime: "15:00" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("departure before arrival → 400, nothing written", async () => {
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: T1.toString(), arrivalTime: "15:00", departureTime: "08:00" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("withdrawn/unknown teacher → 403 and the WHOLE payload is rejected", async () => {
    // Only T1 is active; T2 is withdrawn or does not exist.
    mockTeacherFind.mockReturnValue(teacherChain([{ _id: T1 }]));
    const res = mockRes();
    await markTeacherAttendanceService("2026-11-10", goodRecords, MARKER, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
    // The guard queried with the withdrawn-exclusion filter
    expect(mockTeacherFind.mock.calls[0][0]).toMatchObject({ isWithdrawn: { $ne: true } });
  });

  it("duplicate teacher in one payload → 400", async () => {
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [goodRecords[0], { ...goodRecords[0], departureTime: "16:00" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("invalid teacher id → 400", async () => {
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: "not-an-id", arrivalTime: "08:00", departureTime: "15:00" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("markTeacherAttendanceService — partial corrections of captured times", () => {
  const captured = [{
    teacher: T1, date: new Date(2026, 10, 10),
    arrivalTime: "08:05", departureTime: "", workingMinutes: 0,
    isLate: false, lateMinutes: 0,
    arrivalSource: "login", departureSource: "manual",
  }];

  it("departure-only row merges the captured arrival and keeps its provenance", async () => {
    mockTaFind.mockReturnValue({ lean: jest.fn().mockResolvedValue(captured) });
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: T1.toString(), arrivalTime: "", departureTime: "15:00" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    const set = mockTaFindOneAndUpdate.mock.calls[0][1].$set;
    expect(set.arrivalTime).toBe("08:05");       // kept from login capture
    expect(set.departureTime).toBe("15:00");     // manager supplied
    expect(set.workingMinutes).toBe(415);        // merged pair derives minutes
    expect(set.arrivalSource).toBe("login");     // preserved side keeps provenance
    expect(set.departureSource).toBe("manual");
  });

  it("arrival-only row with a captured departure keeps it (reverse direction)", async () => {
    mockTaFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { ...captured[0], departureTime: "15:00", departureSource: "logout" },
    ])});
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: T1.toString(), arrivalTime: "07:30", departureTime: "" }],
      MARKER, res
    );
    const set = mockTaFindOneAndUpdate.mock.calls[0][1].$set;
    expect(set.arrivalTime).toBe("07:30");
    expect(set.departureTime).toBe("15:00");     // kept from logout capture
    expect(set.workingMinutes).toBe(450);
    expect(set.arrivalSource).toBe("manual");
    expect(set.departureSource).toBe("logout");
  });

  it("departure-only with NO stored arrival → 400, nothing written", async () => {
    mockTaFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: T1.toString(), arrivalTime: "", departureTime: "15:00" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("merged pair invalid (corrected arrival after stored departure) → 400, nothing written", async () => {
    mockTaFind.mockReturnValue({ lean: jest.fn().mockResolvedValue([
      { ...captured[0], departureTime: "15:00", departureSource: "logout" },
    ])});
    const res = mockRes();
    await markTeacherAttendanceService(
      "2026-11-10",
      [{ teacher: T1.toString(), arrivalTime: "16:00", departureTime: "" }],
      MARKER, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockTaFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("getTeacherAttendanceDayService", () => {
  it("merges existing records into the roster and sums the day", async () => {
    const day = new Date(2026, 10, 10);
    mockTeacherFind.mockReturnValue(teacherChain([
      { _id: T1, name: "Ayesha", teacherId: "TEA001" },
      { _id: T2, name: "Bilal", teacherId: "TEA002" },
    ]));
    mockTaFind.mockReturnValue(leanChain([
      { teacher: T1, date: day, arrivalTime: "08:00", departureTime: "15:30", workingMinutes: 450, isLate: false, lateMinutes: 0 },
    ]));
    mockSettingsFindOne.mockReturnValue(leanChain({ lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10 }));

    const res = mockRes();
    await getTeacherAttendanceDayService("2026-11-10", res);

    expect(res.status).toHaveBeenCalledWith(200);
    const data = payload(res).data;
    expect(data.teachers).toHaveLength(2);
    expect(data.teachers[0]).toMatchObject({ marked: true, arrivalTime: "08:00", workingMinutes: 450 });
    expect(data.teachers[1]).toMatchObject({ marked: false, arrivalTime: "", workingMinutes: null });
    expect(data.summary).toEqual({ marked: 1, totalTeachers: 2, totalMinutes: 450, lateCount: 0 });
    expect(data.settings).toEqual({ lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 10 });
    // Roster excludes withdrawn teachers
    expect(mockTeacherFind.mock.calls[0][0]).toEqual({ isWithdrawn: { $ne: true } });
  });

  it("rejects a malformed date with 400", async () => {
    const res = mockRes();
    await getTeacherAttendanceDayService("yesterday", res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});