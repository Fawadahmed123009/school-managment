/**
 * Manager test-management access (list scoping + delete attribution).
 *
 * Covers the CONTROLLER branching only; the real delete-audit service logic is
 * exercised in deleteTestAudit.test.js against mocked models.
 *
 *   • GET /tests list: a manager (DB-derived isAttendanceManager) must get the
 *     FULL school-wide list (getAllTestsService), NOT the assignment-scoped one.
 *     A regular non-manager teacher must stay scoped (getTeacherScopedTestsService).
 *   • Manager status is read from the DATABASE via Teacher.findById(id) — the
 *     controller must never branch off req.userAuth.role / req.user.role.
 *   • deleteTestController hands the verified token id to the service as actor.
 */

const mockTeacherFindById = jest.fn();
const mockGetAll = jest.fn();
const mockScoped = jest.fn();
const mockDeleteService = jest.fn();

jest.mock("../models/Staff/teachers.model", () => ({
  findById: (...a) => {
    const p = Promise.resolve(mockTeacherFindById(...a));
    p.select = jest.fn(() => p);
    p.lean = jest.fn(() => p);
    return p;
  },
}));

jest.mock("../services/academic/test.service", () => ({
  getAllTestsService: (...a) => mockGetAll(...a),
  getTeacherScopedTestsService: (...a) => mockScoped(...a),
  deleteTestService: (...a) => mockDeleteService(...a),
}));

const { getTestsByRoleController, deleteTestController } = require("../controllers/academic/test.controller");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => jest.clearAllMocks());

describe("getTestsByRoleController — manager sees all, teacher stays scoped", () => {
  test("manager (isAttendanceManager=true) gets the full school-wide list", async () => {
    mockTeacherFindById.mockResolvedValue({ isAttendanceManager: true });
    const req = { userAuth: { id: "mgr-1" } };
    const res = mockRes();

    await getTestsByRoleController(req, res);

    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(mockScoped).not.toHaveBeenCalled();
  });

  test("regular non-manager teacher stays assignment-scoped (unchanged)", async () => {
    mockTeacherFindById.mockResolvedValue({ isAttendanceManager: false });
    const req = { userAuth: { id: "tch-1" } };
    const res = mockRes();

    await getTestsByRoleController(req, res);

    expect(mockScoped).toHaveBeenCalledWith("tch-1", res);
    expect(mockGetAll).not.toHaveBeenCalled();
  });

  test("admin (id matches no teacher) gets the full list", async () => {
    mockTeacherFindById.mockResolvedValue(null);
    const req = { userAuth: { id: "admin-1" } };
    const res = mockRes();

    await getTestsByRoleController(req, res);

    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(mockScoped).not.toHaveBeenCalled();
  });

  test("manager flag is read from the DB, never from the token's role claim", async () => {
    // A token carrying a self-declared role must not influence the branch: the
    // controller keys solely off the DB lookup for req.userAuth.id.
    mockTeacherFindById.mockResolvedValue({ isAttendanceManager: false });
    const req = { userAuth: { id: "tch-1", role: "admin", isManager: true } };
    const res = mockRes();

    await getTestsByRoleController(req, res);

    // DB says "not a manager" → still scoped, despite the forged role claim.
    expect(mockScoped).toHaveBeenCalled();
    expect(mockGetAll).not.toHaveBeenCalled();
    // And the lookup is keyed off the verified id.
    expect(mockTeacherFindById).toHaveBeenCalledWith("tch-1");
  });
});

describe("deleteTestController — passes the verified token id as the audit actor", () => {
  test("forwards req.userAuth.id to deleteTestService", async () => {
    const req = { params: { testId: "test-9" }, userAuth: { id: "mgr-1" } };
    const res = mockRes();

    await deleteTestController(req, res);

    expect(mockDeleteService).toHaveBeenCalledWith("test-9", "mgr-1", res);
  });
});
