/**
 * C2 — a suspended teacher's status must be re-read on EVERY request.
 *
 * Suspending a teacher is defined in models/Staff/teachers.model.js as "can
 * login but cannot perform any task". Neither the bearer token nor the session
 * cookie carries that flag, and both stay valid for their whole lifetime — so
 * unless the flag is fetched from the database per request, suspension only
 * takes effect the next time the teacher happens to log in.
 *
 * These tests lock the API role middlewares, the view-route role guards and the
 * shared handler in handlers/suspendedGate.handler.js to that behaviour.
 */

const fs = require("fs");
const path = require("path");

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockTeacherFindById = jest.fn();
const mockAdminFindById = jest.fn();
const mockVerifyToken = jest.fn();

// A findById() result that works both when awaited directly (API middlewares)
// and when chained .select().lean() (authView's DB identity lookup).
function chain(doc) {
  return {
    select: () => chain(doc),
    lean: () => Promise.resolve(doc),
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
}

jest.mock("../models/Staff/teachers.model", () => ({
  findById: (...a) => mockTeacherFindById(...a),
}));
jest.mock("../models/Staff/admin.model", () => ({
  findById: (...a) => mockAdminFindById(...a),
}));
jest.mock("../models/Students/students.model", () => ({ findById: jest.fn() }));
jest.mock("../models/Parents/parents.model", () => ({ findById: jest.fn() }));
jest.mock("../utils/verifyToken", () => mockVerifyToken);

const isTeacher = require("../middlewares/isTeacher");
const isAdminOrManager = require("../middlewares/isAdminOrManager");
const isAdminOrTeacher = require("../middlewares/isAdminOrTeacher");
const isAttendanceManager = require("../middlewares/isAttendanceManager");
const {
  SUSPENDED_MESSAGE,
  denySuspendedApi,
  denySuspendedView,
} = require("../handlers/suspendedGate.handler");
const { authView, requireRole, requireAdminOrManager } = require("../middlewares/authView");

const TEACHER_ID = "teacher-111";
const ADMIN_ID = "admin-abc";

const TEACHER = { _id: TEACHER_ID, role: "teacher", isAttendanceManager: false, isSuspended: false };
const MANAGER = { _id: TEACHER_ID, role: "teacher", isAttendanceManager: true, isSuspended: false };
const ADMIN = { _id: ADMIN_ID, role: "admin" };

// ── helpers ──────────────────────────────────────────────────────────────────

function apiRes() {
  const res = {};
  res.status = jest.fn().mockImplementation((code) => {
    res._statusCode = code;
    return res;
  });
  res.json = jest.fn().mockImplementation((body) => {
    res._body = body;
    return res;
  });
  return res;
}

function viewRes() {
  const res = { locals: {} };
  res.status = jest.fn().mockImplementation((code) => {
    res._statusCode = code;
    return res;
  });
  res.render = jest.fn().mockImplementation((view, data) => {
    res._view = view;
    res._render = data;
    return res;
  });
  res.redirect = jest.fn().mockImplementation((url) => {
    res._redirect = url;
    return res;
  });
  return res;
}

/** Wire the DB mocks: `teacher` / `admin` documents as they exist right now. */
function stubDb({ teacher = null, admin = null } = {}) {
  // mockReturnValue (not ResolvedValue): authView chains .select().lean() off
  // the query synchronously, so the stub has to be a query-shaped thenable.
  mockTeacherFindById.mockReturnValue(chain(teacher));
  mockAdminFindById.mockReturnValue(chain(admin));
}

beforeEach(() => {
  mockTeacherFindById.mockReset();
  mockAdminFindById.mockReset();
  mockVerifyToken.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. API role middlewares (Bearer-token routes)
// ═════════════════════════════════════════════════════════════════════════════

describe("API role middlewares reject a suspended teacher", () => {
  // isAttendanceManager is the manager gate; the suspended flag must beat it.
  const cases = [
    ["isTeacher", isTeacher, { ...TEACHER, isSuspended: true }],
    ["isAdminOrManager (manager path)", isAdminOrManager, { ...MANAGER, isSuspended: true }],
    ["isAdminOrTeacher", isAdminOrTeacher, { ...TEACHER, isSuspended: true }],
    ["isAttendanceManager", isAttendanceManager, { ...MANAGER, isSuspended: true }],
  ];

  test.each(cases)("%s → 403, next not called", async (_name, mw, teacher) => {
    stubDb({ teacher });
    const res = apiRes();
    const next = jest.fn();

    await mw({ userAuth: { id: TEACHER_ID } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(403);
    expect(res._body).toEqual({ status: "failed", message: SUSPENDED_MESSAGE });
  });

  test.each(cases)("%s → unsuspended equivalent still passes", async (_name, mw, suspended) => {
    stubDb({ teacher: { ...suspended, isSuspended: false }, admin: ADMIN });
    const res = apiRes();
    const next = jest.fn();

    await mw({ userAuth: { id: TEACHER_ID } }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._statusCode).toBeUndefined();
  });

  test("a full admin is unaffected by the teacher check (no teacher document)", async () => {
    stubDb({ teacher: null, admin: ADMIN });
    const res = apiRes();
    const next = jest.fn();

    await isAdminOrManager({ userAuth: { id: ADMIN_ID } }, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test("non-teacher, non-admin still gets the original access-denied message", async () => {
    stubDb({ teacher: null, admin: null });
    const res = apiRes();

    await isTeacher({ userAuth: { id: "student-9" } }, res, jest.fn());

    expect(res._statusCode).toBe(403);
    expect(res._body.message).not.toBe(SUSPENDED_MESSAGE);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Status is read per request, not cached from the token
// ═════════════════════════════════════════════════════════════════════════════

describe("suspension takes effect on the very next request", () => {
  test("the same token is allowed, then denied the moment the flag flips", async () => {
    const req = { userAuth: { id: TEACHER_ID } }; // identical token both times

    stubDb({ teacher: MANAGER });
    const first = apiRes();
    const firstNext = jest.fn();
    await isAttendanceManager(req, first, firstNext);
    expect(firstNext).toHaveBeenCalledTimes(1);

    // Administrator flips isSuspended; nothing about the request changes.
    stubDb({ teacher: { ...MANAGER, isSuspended: true } });
    const second = apiRes();
    const secondNext = jest.fn();
    await isAttendanceManager(req, second, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(second._statusCode).toBe(403);
    // Two DB reads for two requests → the status is not taken from the token.
    expect(mockTeacherFindById).toHaveBeenCalledTimes(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Shared handler
// ═════════════════════════════════════════════════════════════════════════════

describe("denySuspendedApi / denySuspendedView", () => {
  test("denySuspendedApi only fires for a document that says isSuspended", () => {
    expect(denySuspendedApi(apiRes(), null)).toBe(false);
    expect(denySuspendedApi(apiRes(), undefined)).toBe(false);
    expect(denySuspendedApi(apiRes(), { isSuspended: false })).toBe(false);

    const res = apiRes();
    expect(denySuspendedApi(res, { isSuspended: true })).toBe(true);
    expect(res._statusCode).toBe(403);
    expect(res._body.message).toBe(SUSPENDED_MESSAGE);
  });

  test("denySuspendedView renders the error page once and reports the rejection", () => {
    const okRes = viewRes();
    expect(denySuspendedView({ user: { isSuspended: false } }, okRes)).toBe(false);
    expect(denySuspendedView({}, okRes)).toBe(false);
    expect(okRes._statusCode).toBeUndefined();

    const res = viewRes();
    expect(denySuspendedView({ user: { isSuspended: true } }, res)).toBe(true);
    expect(res._statusCode).toBe(403);
    expect(res._view).toBe("error");
    expect(res._render.message).toBe(SUSPENDED_MESSAGE);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. View routes (signed session cookie half of the app)
// ═════════════════════════════════════════════════════════════════════════════

describe("view-route role guards reject a suspended teacher", () => {
  test("requireRole denies before any role check", async () => {
    const req = { user: { _id: TEACHER_ID, role: "teacher", isSuspended: true } };
    const res = viewRes();
    const next = jest.fn();

    await requireRole("teacher")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(403);
    expect(res._render.message).toBe(SUSPENDED_MESSAGE);
  });

  test("requireAdminOrManager denies a suspended manager", async () => {
    const req = { user: { _id: TEACHER_ID, role: "teacher", isManager: true, isSuspended: true } };
    const res = viewRes();

    await requireAdminOrManager()(req, res, jest.fn());

    expect(res._statusCode).toBe(403);
    expect(res._render.message).toBe(SUSPENDED_MESSAGE);
  });

  test("unsuspended teacher / manager still reach their pages", async () => {
    const teacherReq = { user: { _id: TEACHER_ID, role: "teacher", isSuspended: false } };
    const teacherNext = jest.fn();
    await requireRole("teacher")(teacherReq, viewRes(), teacherNext);
    expect(teacherNext).toHaveBeenCalledTimes(1);

    const managerReq = { user: { _id: TEACHER_ID, role: "teacher", isManager: true, isSuspended: false } };
    const managerNext = jest.fn();
    await requireAdminOrManager()(managerReq, viewRes(), managerNext);
    expect(managerNext).toHaveBeenCalledTimes(1);
  });

  test("isSuspended on req.user comes from the database, not from the cookie", async () => {
    // A cookie that claims "admin" cannot un-suspend anyone: identity fields are
    // re-derived from the DB on every request.
    const req = {
      signedCookies: {
        session: JSON.stringify({
          token: "signed-token",
          user: { _id: TEACHER_ID, name: "Suspended Teacher", role: "admin", isSuspended: false },
        }),
      },
    };
    mockVerifyToken.mockReturnValue({ id: TEACHER_ID });
    stubDb({ teacher: { ...MANAGER, isSuspended: true } });

    await authView(req, viewRes(), jest.fn());

    expect(req.user.role).toBe("teacher"); // cookie claim overridden by DB truth
    expect(req.user.isManager).toBe(true);
    expect(req.user.isSuspended).toBe(true);

    const res = viewRes();
    const next = jest.fn();
    await requireAdminOrManager()(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Guards that bypass subject-assignment checks must be gated first
// ═════════════════════════════════════════════════════════════════════════════

describe("manager-bypass paths check suspension before bypassing", () => {
  function sourceOf(file) {
    return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  }

  function guardBody(source, guardName) {
    const start = source.indexOf(guardName);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n};", start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  // The gate must run before the guard can hand the request to the handler.
  function assertGatedBeforeGrant(body) {
    const gate = body.indexOf("denySuspendedApi");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf("next("));
  }

  test("test.router.js — isAdminOrTeacher", () => {
    const source = sourceOf("routes/v1/academic/test.router.js");
    assertGatedBeforeGrant(guardBody(source, "const isAdminOrTeacher = async"));
  });

  test("test.router.js — isTeacherAssignedOrManager (mark-any-test bypass)", () => {
    const source = sourceOf("routes/v1/academic/test.router.js");
    const body = guardBody(source, "const isTeacherAssignedOrManager = async");
    assertGatedBeforeGrant(body);
    // Explicitly: suspension is checked before the manager bypass branch.
    expect(body.indexOf("denySuspendedApi")).toBeLessThan(body.indexOf("isAttendanceManager"));
  });

  test("isAssignedToSubject.js — isAssignedToTestView (view mark-any-test bypass)", () => {
    const source = sourceOf("middlewares/isAssignedToSubject.js");
    const body = guardBody(source, "const isAssignedToTestView");
    assertGatedBeforeGrant(body);
    expect(body.indexOf("denySuspendedApi")).toBeLessThan(body.indexOf("isAttendanceManager"));
  });
});
