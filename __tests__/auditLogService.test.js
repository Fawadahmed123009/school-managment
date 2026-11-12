/**
 * Audit trail foundation — core recorder + viewer queries:
 * - FAIL-OPEN contract: recordAudit never throws and never blocks; a failed
 *   write is reported to the server error log and swallowed.
 * - Actor role is resolved from the DB (admin / manager / teacher), never
 *   from a claim; {teacher} summary placeholders resolve off the main path.
 * - IP comes from the request context (AsyncLocalStorage) when present.
 * - Snapshots hold ONLY changed fields (changedFields helper).
 * - Viewer query: inclusive local-day range, entity/user filters, newest
 *   first, name resolution, pagination; invalid filters fail closed (400).
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockAuditCreate = jest.fn();
const mockAuditFind = jest.fn();
const mockAuditCount = jest.fn();
const mockAuditDistinct = jest.fn();
const mockAdminFindById = jest.fn();
const mockAdminFind = jest.fn();
const mockTeacherFindById = jest.fn();
const mockTeacherFind = jest.fn();
const mockLogError = jest.fn();
const mockLogWarn = jest.fn();

jest.mock("../models/Audit/auditLog.model", () => ({
  create: (...a) => mockAuditCreate(...a),
  find: (...a) => mockAuditFind(...a),
  countDocuments: (...a) => mockAuditCount(...a),
  distinct: (...a) => mockAuditDistinct(...a),
}));
jest.mock("../models/Staff/admin.model", () => ({
  findById: (...a) => mockAdminFindById(...a),
  find: (...a) => mockAdminFind(...a),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  findById: (...a) => mockTeacherFindById(...a),
  find: (...a) => mockTeacherFind(...a),
}));
jest.mock("../config/logger", () => ({
  error: (...a) => mockLogError(...a),
  warn: (...a) => mockLogWarn(...a),
  info: jest.fn(),
  debug: jest.fn(),
}));

const mongoose = require("mongoose");
const {
  recordAudit,
  flushAuditWrites,
  changedFields,
  formatDay,
  formatMoney,
  getAuditLogsService,
  getAuditLogMetaService,
} = require("../services/audit/auditLog.service");
const { requestContext } = require("../middlewares/requestContext");

const ADMIN = new mongoose.Types.ObjectId();
const MANAGER = new mongoose.Types.ObjectId();
const TEACHER = new mongoose.Types.ObjectId();
const ENTITY = new mongoose.Types.ObjectId();

// The recorder skips writes unless the DB is connected — unit tests run
// without a connection, so simulate "connected" for the recorder tests.
beforeAll(() => {
  Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
});
afterAll(() => {
  delete mongoose.connection.readyState;
});

const leanChain = (doc) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(doc),
});

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const payload = (res) => res.json.mock.calls[0][0];

const baseEntry = () => ({
  userId: ADMIN,
  actionType: "create",
  entityType: "expense_head",
  entityId: ENTITY,
  summary: 'Created expense head "Printing"',
  afterSnapshot: { name: "Printing", isActive: true },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAuditCreate.mockImplementation(async (doc) => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
  mockAdminFindById.mockReturnValue(leanChain({ _id: ADMIN, name: "Root Admin", role: "admin" }));
  mockTeacherFindById.mockReturnValue(leanChain(null));
  mockAdminFind.mockReturnValue(leanChain([]));
  mockTeacherFind.mockReturnValue(leanChain([]));
  mockAuditDistinct.mockResolvedValue([]);
});

describe("recordAudit — fail-open, non-blocking contract", () => {
  it("writes one row with the DB-resolved admin role and the entry payload", async () => {
    recordAudit(baseEntry());
    await flushAuditWrites();
    expect(mockAuditCreate).toHaveBeenCalledTimes(1);
    const doc = mockAuditCreate.mock.calls[0][0];
    expect(doc).toMatchObject({
      userId: ADMIN,
      userRole: "admin",
      actionType: "create",
      entityType: "expense_head",
      entityId: ENTITY,
      summary: 'Created expense head "Printing"',
      afterSnapshot: { name: "Printing", isActive: true },
      beforeSnapshot: null,
    });
    expect(doc.timestamp).toBeInstanceOf(Date);
  });

  it("resolves a manager role from Teacher.isAttendanceManager (DB, not claims)", async () => {
    mockAdminFindById.mockReturnValue(leanChain(null));
    mockTeacherFindById.mockReturnValue(leanChain({ _id: MANAGER, name: "Mgr", isAttendanceManager: true }));
    recordAudit({ ...baseEntry(), userId: MANAGER });
    await flushAuditWrites();
    expect(mockAuditCreate.mock.calls[0][0].userRole).toBe("manager");
  });

  it("resolves a plain teacher role when the flag is absent", async () => {
    mockAdminFindById.mockReturnValue(leanChain(null));
    mockTeacherFindById.mockReturnValue(leanChain({ _id: TEACHER, name: "Teach", isAttendanceManager: false }));
    recordAudit({ ...baseEntry(), userId: TEACHER });
    await flushAuditWrites();
    expect(mockAuditCreate.mock.calls[0][0].userRole).toBe("teacher");
  });

  it("unknown actor → role 'unknown', row still written", async () => {
    mockAdminFindById.mockReturnValue(leanChain(null));
    mockTeacherFindById.mockReturnValue(leanChain(null));
    recordAudit(baseEntry());
    await flushAuditWrites();
    expect(mockAuditCreate.mock.calls[0][0].userRole).toBe("unknown");
  });

  it("interpolates a {teacher} placeholder off the main path", async () => {
    mockTeacherFindById.mockReturnValue(leanChain({ _id: TEACHER, name: "Alice Khan" }));
    recordAudit({
      ...baseEntry(),
      entityType: "salary_run",
      actionType: "finalize",
      teacherId: TEACHER,
      summary: "Finalized salary run for {teacher}, 1 Nov – 30 Nov",
    });
    await flushAuditWrites();
    expect(mockAuditCreate.mock.calls[0][0].summary).toBe("Finalized salary run for Alice Khan, 1 Nov – 30 Nov");
  });

  it("captures the client IP from the request context when present", async () => {
    requestContext({ ip: "203.0.113.7" }, {}, () => {
      recordAudit(baseEntry());
    });
    await flushAuditWrites();
    expect(mockAuditCreate.mock.calls[0][0].ipAddress).toBe("203.0.113.7");
  });

  it("outside a request the IP stays empty (optional field)", async () => {
    recordAudit(baseEntry());
    await flushAuditWrites();
    expect(mockAuditCreate.mock.calls[0][0].ipAddress).toBe("");
  });

  it("a FAILED write never throws — it is logged to the error log and swallowed", async () => {
    mockAuditCreate.mockRejectedValue(new Error("mongo down"));
    expect(() => recordAudit(baseEntry())).not.toThrow();
    await expect(flushAuditWrites()).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][0]).toMatch(/audit-log write failed.*expense_head\/create/);
  });

  it("a synchronous model throw is also contained (never reaches the caller)", async () => {
    mockAuditCreate.mockImplementation(() => { throw new Error("sync boom"); });
    expect(() => recordAudit(baseEntry())).not.toThrow();
    await flushAuditWrites();
    expect(mockLogError).toHaveBeenCalled();
  });

  it("actor-resolution failure is contained too", async () => {
    mockAdminFindById.mockImplementation(() => { throw new Error("auth db boom"); });
    expect(() => recordAudit(baseEntry())).not.toThrow();
    await flushAuditWrites();
    expect(mockLogError).toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it("skips quietly when the DB is disconnected (unit-test / outage state 0)", async () => {
    Object.defineProperty(mongoose.connection, "readyState", { value: 0, configurable: true });
    recordAudit(baseEntry());
    await flushAuditWrites();
    expect(mockAuditCreate).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
    Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
  });

  it("missing userId or invalid action/entity → no write", async () => {
    recordAudit({ ...baseEntry(), userId: undefined });
    recordAudit({ ...baseEntry(), actionType: "explode" });
    recordAudit({ ...baseEntry(), entityType: "not_a_thing" });
    recordAudit(null);
    await flushAuditWrites();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

describe("changedFields — lightweight snapshots (only what changed)", () => {
  it("keeps only the differing keys", () => {
    const diff = changedFields(
      { arrivalTime: "08:00", departureTime: "15:00", arrivalSource: "login" },
      { arrivalTime: "08:05", departureTime: "15:00", arrivalSource: "manual" },
      ["arrivalTime", "departureTime", "arrivalSource"]
    );
    expect(diff).toEqual({
      before: { arrivalTime: "08:00", arrivalSource: "login" },
      after: { arrivalTime: "08:05", arrivalSource: "manual" },
    });
  });

  it("returns null when nothing changed", () => {
    expect(changedFields({ a: 1 }, { a: 1 }, ["a"])).toBeNull();
  });

  it("normalizes undefined to empty string in snapshots", () => {
    const diff = changedFields({}, { arrivalTime: "08:00" }, ["arrivalTime"]);
    expect(diff.before.arrivalTime).toBe("");
    // "" vs a value IS a change — legacy-source normalization (missing →
    // "manual") is the attendance hook's job, not the generic diff's.
    const d2 = changedFields({}, { arrivalSource: "manual" }, ["arrivalSource"]);
    expect(d2.before.arrivalSource).toBe("");
    expect(d2.after.arrivalSource).toBe("manual");
  });
});

describe("display helpers", () => {
  it("formatDay renders a local-calendar day", () => {
    expect(formatDay(new Date(2026, 10, 15))).toBe("15 Nov 2026");
  });
  it("formatMoney follows the Rs convention", () => {
    expect(formatMoney(113.75)).toMatch(/^Rs 113\.75$/);
  });
});

describe("getAuditLogsService — viewer filters", () => {
  const findChain = (docs) => ({
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(docs),
  });

  beforeEach(() => {
    mockAuditFind.mockReturnValue(findChain([]));
    mockAuditCount.mockResolvedValue(0);
  });

  it("builds an INCLUSIVE local-day range on timestamp", async () => {
    const res = mockRes();
    await getAuditLogsService({ from: "2026-11-01", to: "2026-11-30" }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const filter = mockAuditFind.mock.calls[0][0];
    expect(filter.timestamp.$gte).toEqual(new Date(2026, 10, 1));
    expect(filter.timestamp.$lt).toEqual(new Date(2026, 11, 1));
  });

  it("filters by entity type and casts the user filter to ObjectId", async () => {
    const res = mockRes();
    await getAuditLogsService({ entityType: "salary_run", userId: String(ADMIN) }, res);
    const filter = mockAuditFind.mock.calls[0][0];
    expect(filter.entityType).toBe("salary_run");
    expect(filter.userId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(filter.userId)).toBe(String(ADMIN));
  });

  it("sorts newest first and resolves actor names", async () => {
    const chain = findChain([
      { _id: new mongoose.Types.ObjectId(), userId: ADMIN, summary: "x", timestamp: new Date() },
    ]);
    mockAuditFind.mockReturnValue(chain);
    mockAuditCount.mockResolvedValue(1);
    mockAdminFind.mockReturnValue(leanChain([{ _id: ADMIN, name: "Root Admin", role: "admin" }]));
    const res = mockRes();
    await getAuditLogsService({}, res);
    expect(chain.sort).toHaveBeenCalledWith("-timestamp");
    const data = payload(res).data;
    expect(data.logs[0].userName).toBe("Root Admin");
    expect(data.pagination.total).toBe(1);
  });

  it.each([
    ["bad from date", { from: "2026-02-30" }],
    ["bad to date", { to: "nope" }],
    ["from after to", { from: "2026-12-01", to: "2026-11-01" }],
    ["unknown entity type", { entityType: "warp_core" }],
    ["invalid user id", { userId: "not-an-id" }],
  ])("%s → 400 and no query", async (_label, filters) => {
    const res = mockRes();
    await getAuditLogsService(filters, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAuditFind).not.toHaveBeenCalled();
  });
});

describe("getAuditLogMetaService — filter options", () => {
  it("returns the entity catalog and distinct trail users sorted by name", async () => {
    mockAuditDistinct.mockResolvedValue([ADMIN, MANAGER]);
    mockAdminFind.mockReturnValue(leanChain([{ _id: ADMIN, name: "Zed", role: "admin" }]));
    mockTeacherFind.mockReturnValue(leanChain([{ _id: MANAGER, name: "Alice", isAttendanceManager: true }]));
    const res = mockRes();
    await getAuditLogMetaService(res);
    const data = payload(res).data;
    expect(data.entityTypes).toContain("salary_run");
    expect(data.users.map((u) => u.name)).toEqual(["Alice", "Zed"]);
    expect(data.users[0].role).toBe("manager");
  });
});