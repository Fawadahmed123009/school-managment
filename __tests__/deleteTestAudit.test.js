/**
 * deleteTestService — audited, fail-closed cascade (mirrors the fee audit).
 *
 * The test, its submitted TestResult rows and the append-only TestAudit row are
 * written together. If the audit row cannot be written, the deletion must NOT
 * happen (fail-closed). The audit row records who/when/what and how many scores
 * were destroyed.
 *
 * The actor identity for the audit is resolved from the DATABASE (Admin /
 * Teacher lookups keyed off the verified token id), never from a role claim.
 *
 * Unit tests run without a Mongo connection, so withTransaction degrades to the
 * sequential path (audit written FIRST) — which is exactly the fail-closed
 * behaviour asserted here.
 */

const chain = (value) => {
  const p = Promise.resolve(value);
  p.populate = jest.fn(() => p);
  p.select = jest.fn(() => p);
  p.lean = jest.fn(() => p);
  p.sort = jest.fn(() => p);
  return p;
};

const mockTest = {
  findById: jest.fn(),
  deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
};
const mockTestResult = {
  countDocuments: jest.fn(),
  deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  find: jest.fn(() => chain([])),
};
const mockTestAudit = { create: jest.fn() };
const mockAdminFindById = jest.fn();
const mockTeacherFindById = jest.fn();

jest.mock("../models/Academic/test.model", () => mockTest);
jest.mock("../models/Academic/testResult.model", () => mockTestResult);
jest.mock("../models/Academic/testAudit.model", () => mockTestAudit);
jest.mock("../models/Academic/testSession.model", () => ({ findById: () => chain(null) }));
jest.mock("../models/Academic/subject.model", () => ({ findById: () => chain(null) }));
jest.mock("../models/Academic/class.model", () => ({ findById: () => chain(null) }));
jest.mock("../models/Students/students.model", () => ({ find: () => chain([]) }));
jest.mock("../models/Academic/assignment.model", () => ({
  find: () => chain([]),
  findOne: () => chain(null),
  distinct: () => chain([]),
}));
jest.mock("../services/academic/assignment.service", () => ({ getAssignedClassLevels: async () => [] }));
jest.mock("../models/Staff/admin.model", () => ({
  findById: (...a) => {
    const p = Promise.resolve(mockAdminFindById(...a));
    p.select = jest.fn(() => p);
    p.lean = jest.fn(() => p);
    return p;
  },
}));
jest.mock("../models/Staff/teachers.model", () => ({
  findById: (...a) => {
    const p = Promise.resolve(mockTeacherFindById(...a));
    p.select = jest.fn(() => p);
    p.lean = jest.fn(() => p);
    return p;
  },
}));

const { deleteTestService } = require("../services/academic/test.service");

const TEST_ID = "test-1";
const ACTOR_ID = "manager-1";

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const deletedDoc = {
  _id: TEST_ID,
  name: "Mid Term",
  subject: { _id: "sub-1", name: "Math" },
  classLevels: [{ _id: "cls-1", name: "Grade 9 A" }],
  date: new Date("2026-01-10"),
  totalMarks: 50,
  passMarks: 20,
  session: "sess-1",
  phase: "phase-1",
  week: "week-1",
  createdBy: "admin-0",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockTest.findById.mockReturnValue(chain(deletedDoc));
  mockTest.deleteOne.mockResolvedValue({ deletedCount: 1 });
  mockTestResult.countDocuments.mockResolvedValue(7);
  mockTestResult.deleteMany.mockResolvedValue({ deletedCount: 7 });
  mockTestAudit.create.mockResolvedValue([{ _id: "audit-1" }]);
  mockAdminFindById.mockResolvedValue(null); // actor is a manager, not an admin
  mockTeacherFindById.mockResolvedValue({ name: "Aisha", isAttendanceManager: true });
});

describe("deleteTestService — audited, fail-closed cascade", () => {
  test("writes the audit row and cascades the results + test", async () => {
    const res = mockRes();
    await deleteTestService(TEST_ID, ACTOR_ID, res);

    expect(mockTestAudit.create).toHaveBeenCalledTimes(1);
    const entry = mockTestAudit.create.mock.calls[0][0][0];
    expect(entry.action).toBe("delete");
    expect(entry.test).toBe(TEST_ID);
    expect(entry.actor).toBe(ACTOR_ID);
    expect(entry.actorRole).toBe("manager"); // DB-derived, not a forged claim
    expect(entry.actorName).toBe("Aisha");
    expect(entry.resultsRemoved).toBe(7);
    expect(entry.snapshot).toMatchObject({
      name: "Mid Term",
      subject: "Math",
      classLevels: ["Grade 9 A"],
      totalMarks: 50,
      passMarks: 20,
    });

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0].data;
    expect(payload.deletedResults).toBe(7);
    expect(mockTestResult.deleteMany).toHaveBeenCalled();
    expect(mockTest.deleteOne).toHaveBeenCalled();
  });

  test("fail-closed: an audit write failure aborts the delete (nothing removed)", async () => {
    mockTestAudit.create.mockRejectedValue(new Error("audit store offline"));
    const res = mockRes();

    await expect(deleteTestService(TEST_ID, ACTOR_ID, res)).rejects.toThrow(/audit/i);

    // The cascade must NOT have run — an untracked delete is impossible.
    expect(mockTestResult.deleteMany).not.toHaveBeenCalled();
    expect(mockTest.deleteOne).not.toHaveBeenCalled();
  });

  test("missing actor id is refused before any write", async () => {
    const res = mockRes();
    await expect(deleteTestService(TEST_ID, undefined, res)).rejects.toThrow(/actor/i);
    expect(mockTestAudit.create).not.toHaveBeenCalled();
    expect(mockTest.deleteOne).not.toHaveBeenCalled();
  });

  test("unknown test → 404, no audit, no delete", async () => {
    mockTest.findById.mockReturnValue(chain(null));
    const res = mockRes();
    await deleteTestService("ghost", ACTOR_ID, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockTestAudit.create).not.toHaveBeenCalled();
    expect(mockTest.deleteOne).not.toHaveBeenCalled();
  });
});
