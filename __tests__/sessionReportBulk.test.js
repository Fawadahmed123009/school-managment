/**
 * Tests for the session-report BULK endpoint (class / selected sections) and
 * the phase/week period filter on the single-student twin.
 *
 * The bulk endpoint hands out full parent-facing report cards for many
 * students at once, so it inherits the Finding B-1 gate: admin/manager only,
 * enforced from DB-resolved identity (the API token carries just { id }).
 *
 * Controller-level tests mock the service (no real PDFs); pure shaping
 * helpers are unit-tested separately in sessionReportPeriodFilter.test.js.
 */

const mockStudentFind = jest.fn();
const mockSessionFindById = jest.fn();
const mockBulkService = jest.fn();
const mockSingleService = jest.fn();

jest.mock("../models/Academic/test.model", () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock("../models/Academic/assignment.model", () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock("../models/Academic/testResult.model", () => ({ find: jest.fn() }));
jest.mock("../models/Students/students.model", () => ({
  find: () => ({ select: () => ({ lean: () => mockStudentFind() }) }),
  findById: jest.fn(),
}));
jest.mock("../models/Academic/testSession.model", () => ({
  findById: () => ({ select: () => ({ lean: () => mockSessionFindById() }) }),
}));

// Identity resolves from the DB: default "not an admin, plain non-manager
// teacher" so bare-token requests exercise the restricted branch.
jest.mock("../models/Staff/admin.model", () => ({
  findById: () => ({ select: () => ({ lean: async () => null }) }),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  findById: () => ({ select: () => ({ lean: async () => ({ isAttendanceManager: false }) }) }),
}));

jest.mock("../services/academic/pdfReport.service", () => ({
  generateResultSheetPDF: jest.fn(),
  generateAnalyticsPDF: jest.fn(),
  generateSessionReportPDF: (...a) => mockSingleService(...a),
  generateSessionReportBulkPDFs: (...a) => mockBulkService(...a),
  getPdfPath: jest.fn(),
}));

jest.mock("../handlers/responseStatus.handler", () => jest.fn((res, status, statusText, data) => {
  res.status(status).json({ status: statusText, message: data });
}));

const { generateSessionReport, generateSessionReportBulk } = require("../controllers/academic/pdfReport.controller");

// ── Helpers ──────────────────────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const ADMIN = { id: "admin-1", role: "admin", isManager: false };
const MANAGER = { id: "manager-1", role: "teacher", isManager: true };

function mockReq(body, user) {
  return { body, userAuth: user };
}

// Real teacher Bearer token carries ONLY { id } — identity comes from the DB.
function mockReqBare(body, id) {
  return { body, userAuth: { id } };
}

const SESSION_ID = "507f1f77bcf86cd799439055";
const CLASS_9A = "507f1f77bcf86cd799439033";
const CLASS_9B = "507f1f77bcf86cd799439044";

// ── Bulk endpoint: access control ────────────────────────────────────────────
describe("session-report bulk — access control (B-1 gate inherited)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("REJECTS a plain teacher (403) and never reaches the PDF generator", async () => {
    const req = mockReq(
      { sessionId: SESSION_ID, scope: "class", classLevelId: CLASS_9A },
      { id: "teacher-1", role: "teacher", isManager: false }
    );
    const res = mockRes();

    await generateSessionReportBulk(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockBulkService).not.toHaveBeenCalled();
  });

  test("ROOT CAUSE: id-only token resolving to a teacher in the DB is rejected (403)", async () => {
    const req = mockReqBare({ sessionId: SESSION_ID, scope: "sections", classLevelIds: [CLASS_9A] }, "teacher-x");
    const res = mockRes();

    await generateSessionReportBulk(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockBulkService).not.toHaveBeenCalled();
  });

  test("ACCEPTS admin and manager (gate opens for both)", async () => {
    for (const user of [ADMIN, MANAGER]) {
      jest.clearAllMocks();
      mockSessionFindById.mockResolvedValue({ _id: SESSION_ID });
      mockStudentFind.mockResolvedValue([{ _id: "s1" }]);
      mockBulkService.mockResolvedValue([{ status: "generated", name: "A", uuid: "u1", pdfUrl: "/reports/pdf/u1" }]);

      const res = mockRes();
      await generateSessionReportBulk(mockReq({ sessionId: SESSION_ID, scope: "class", classLevelId: CLASS_9A }, user), res);

      expect(res.status).toHaveBeenCalledWith(200);
    }
  });
});

// ── Bulk endpoint: scope resolution ──────────────────────────────────────────
describe("session-report bulk — scope resolution and guards", () => {
  beforeEach(() => jest.clearAllMocks());

  test("scope=class resolves exactly the one picked ClassLevel", async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID });
    mockStudentFind.mockResolvedValue([{ _id: "s1" }, { _id: "s2" }]);
    mockBulkService.mockResolvedValue([]);

    const res = mockRes();
    await generateSessionReportBulk(
      mockReq({ sessionId: SESSION_ID, scope: "class", classLevelId: CLASS_9A, phaseId: "p1", weekId: "w2" }, ADMIN),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const [args] = mockBulkService.mock.calls[0];
    expect(args.sessionId).toBe(SESSION_ID);
    expect(args.studentIds).toEqual(["s1", "s2"]);
    expect(args.phaseId).toBe("p1");
    expect(args.weekId).toBe("w2");
  });

  test("scope=sections accepts the checkbox array and rejects forged/non-ObjectId values", async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID });
    mockStudentFind.mockResolvedValue([{ _id: "s1" }]);
    mockBulkService.mockResolvedValue([]);

    const res = mockRes();
    await generateSessionReportBulk(
      mockReq({ sessionId: SESSION_ID, scope: "sections", classLevelIds: [CLASS_9A, "9B", CLASS_9B] }, ADMIN),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    // The query passed to Student.find keeps only the two valid ids.
    // (Controller sanitises before querying.)
  });

  test("scope=sections with ONLY invalid ids → 400 before any DB round-trip", async () => {
    const res = mockRes();
    await generateSessionReportBulk(mockReq({ sessionId: SESSION_ID, scope: "sections", classLevelIds: ["nope", "9B"] }, ADMIN), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockBulkService).not.toHaveBeenCalled();
  });

  test("unknown scope is refused (only class/sections bulk through)", async () => {
    const res = mockRes();
    await generateSessionReportBulk(mockReq({ sessionId: SESSION_ID, scope: "school", classLevelIds: [CLASS_9A] }, ADMIN), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("invalid sessionId → 400; missing session → 404", async () => {
    const res1 = mockRes();
    await generateSessionReportBulk(mockReq({ sessionId: "not-an-id", scope: "class", classLevelId: CLASS_9A }, ADMIN), res1);
    expect(res1.status).toHaveBeenCalledWith(400);

    mockSessionFindById.mockResolvedValue(null);
    const res2 = mockRes();
    await generateSessionReportBulk(mockReq({ sessionId: SESSION_ID, scope: "class", classLevelId: CLASS_9A }, ADMIN), res2);
    expect(res2.status).toHaveBeenCalledWith(404);
  });

  test("class with no active students → 400 and no generation", async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID });
    mockStudentFind.mockResolvedValue([]);

    const res = mockRes();
    await generateSessionReportBulk(mockReq({ sessionId: SESSION_ID, scope: "class", classLevelId: CLASS_9A }, ADMIN), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/no active students/i);
    expect(mockBulkService).not.toHaveBeenCalled();
  });

  test("enrollment query only pulls currently-enrolled students", async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID });
    mockStudentFind.mockResolvedValue([{ _id: "s1" }]);
    mockBulkService.mockResolvedValue([]);

    // Capture the filter handed to Student.find via the model stub.
    const Student = require("../models/Students/students.model");
    const findSpy = jest.spyOn(Student, "find");

    const res = mockRes();
    await generateSessionReportBulk(mockReq({ sessionId: SESSION_ID, scope: "class", classLevelId: CLASS_9A }, ADMIN), res);

    const filter = findSpy.mock.calls[0][0];
    expect(filter.status).toBe("active");
    expect(filter.isWithdrawn).toBe(false);
    expect(filter.isGraduated).toBe(false);
    findSpy.mockRestore();
  });

  test("over-cap roster → 400 with the cap named, generator untouched", async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID });
    mockStudentFind.mockResolvedValue(Array.from({ length: 301 }, (_, i) => ({ _id: `s${i}` })));

    const res = mockRes();
    await generateSessionReportBulk(mockReq({ sessionId: SESSION_ID, scope: "class", classLevelId: CLASS_9A }, ADMIN), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/300/);
    expect(mockBulkService).not.toHaveBeenCalled();
  });

  test("counts of generated vs skipped reports come back to the caller", async () => {
    mockSessionFindById.mockResolvedValue({ _id: SESSION_ID });
    mockStudentFind.mockResolvedValue([{ _id: "s1" }, { _id: "s2" }, { _id: "s3" }]);
    mockBulkService.mockResolvedValue([
      { status: "generated", name: "A", pdfUrl: "/reports/pdf/u1" },
      { status: "skipped", name: "B" },
      { status: "generated", name: "C", pdfUrl: "/reports/pdf/u2" },
    ]);

    const res = mockRes();
    await generateSessionReportBulk(mockReq({ sessionId: SESSION_ID, scope: "class", classLevelId: CLASS_9A }, ADMIN), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0].message;
    expect(payload.generatedCount).toBe(2);
    expect(payload.skippedCount).toBe(1);
    expect(payload.reports).toHaveLength(3);
  });
});

// ── Single-student twin: period passthrough ──────────────────────────────────
describe("session-report single — phase/week period passthrough", () => {
  beforeEach(() => jest.clearAllMocks());

  test("hands phaseId/weekId to the service as the period argument", async () => {
    mockSingleService.mockResolvedValue({ uuid: "u1", singleStudent: null });

    const res = mockRes();
    await generateSessionReport(
      mockReq({ sessionId: SESSION_ID, studentId: "s1", phaseId: "p1", weekId: "" }, ADMIN),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const period = mockSingleService.mock.calls[0][3];
    expect(period.phaseId).toBe("p1");
    // Empty strings must not leak through as filters.
    expect(period.weekId).toBeUndefined();
  });
});
