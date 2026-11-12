/**
 * Access-control tests for teacher attendance (Phase 1):
 * - API: marking/day/teachers/history + settings READ require isLoggedIn +
 *   isAdminOrManager; settings WRITE requires isLoggedIn + isAdmin (admin only).
 * - Views: marking/history pages allow admin OR manager (DB-derived flag),
 *   reject regular teachers/students/parents and suspended managers;
 *   the settings page is admin-only.
 *
 * Middleware identity is asserted on the actual router stack, and the view
 * guards are exercised with mock req/res — no token/cookie claim is trusted.
 */

const isLoggedIn = require("../middlewares/isLoggedIn");
const isAdminOrManager = require("../middlewares/isAdminOrManager");
const isAdmin = require("../middlewares/isAdmin");

const apiRouter = require("../routes/v1/staff/teacherAttendance.router");
const viewRouter = require("../routes/views/staffAttendance.views");

// ── helpers ───────────────────────────────────────────────────────────────────

function apiRoute(path, method) {
  const layer = apiRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) return null;
  // GET+PUT share one route object on the same path — keep only the layers
  // registered for the method under test (layer.method is set per handler).
  return layer.route.stack
    .filter((s) => !s.method || s.method === method)
    .map((s) => s.handle);
}

function viewGuard(path, method) {
  const layer = viewRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  // First handler in the route stack is the role guard wrapper.
  return layer ? layer.route.stack[0].handle : null;
}

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    render: jest.fn(),
    locals: { schoolName: "Test School" },
  };
}

async function runGuard(guard, user) {
  const req = { user };
  const res = mockRes();
  const next = jest.fn();
  await guard(req, res, next);
  return { res, next };
}

// ── API route wiring ─────────────────────────────────────────────────────────

describe("API router wiring (Bearer-token layer)", () => {
  it.each([
    ["/teacher-attendance", "post"],
    ["/teacher-attendance/day", "get"],
    ["/teacher-attendance/teachers", "get"],
    ["/teacher-attendance/history", "get"],
    ["/teacher-attendance/settings", "get"],
  ])("%s %s is gated by isLoggedIn + isAdminOrManager", (path, method) => {
    const handlers = apiRoute(path, method);
    expect(handlers).not.toBeNull();
    expect(handlers).toContain(isLoggedIn);
    expect(handlers).toContain(isAdminOrManager);
    expect(handlers).not.toContain(isAdmin);
  });

  it("settings PUT is ADMIN ONLY (isAdmin, not isAdminOrManager)", () => {
    const handlers = apiRoute("/teacher-attendance/settings", "put");
    expect(handlers).not.toBeNull();
    expect(handlers).toContain(isLoggedIn);
    expect(handlers).toContain(isAdmin);
    expect(handlers).not.toContain(isAdminOrManager);
  });
});

// ── View guards (signed-cookie layer) ────────────────────────────────────────

describe("view guards — marking & history (admin OR manager)", () => {
  const guards = [
    ["GET marking page", viewGuard("/teacher-attendance", "get")],
    ["POST marking", viewGuard("/teacher-attendance", "post")],
    ["GET history", viewGuard("/teacher-attendance/history", "get")],
  ];

  it.each(guards)("%s allows admin", async (_label, guard) => {
    const { next, res } = await runGuard(guard, { role: "admin" });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(guards)("%s allows a manager (teacher with isManager)", async (_label, guard) => {
    const { next } = await runGuard(guard, { role: "teacher", isManager: true });
    expect(next).toHaveBeenCalled();
  });

  it.each(guards)("%s rejects a regular teacher", async (_label, guard) => {
    const { next, res } = await runGuard(guard, { role: "teacher", isManager: false });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each(guards)("%s rejects a SUSPENDED manager", async (_label, guard) => {
    const { next, res } = await runGuard(guard, { role: "teacher", isManager: true, isSuspended: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each(guards)("%s rejects students and parents", async (_label, guard) => {
    for (const role of ["student", "parent"]) {
      const { next, res } = await runGuard(guard, { role });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });
});

describe("view guards — late-rule settings (ADMIN only)", () => {
  const guards = [
    ["GET settings", viewGuard("/teacher-attendance/settings", "get")],
    ["POST settings", viewGuard("/teacher-attendance/settings", "post")],
  ];

  it.each(guards)("%s allows admin", async (_label, guard) => {
    const { next } = await runGuard(guard, { role: "admin" });
    expect(next).toHaveBeenCalled();
  });

  it.each(guards)("%s rejects even a manager", async (_label, guard) => {
    const { next, res } = await runGuard(guard, { role: "teacher", isManager: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each(guards)("%s rejects regular teachers", async (_label, guard) => {
    const { next, res } = await runGuard(guard, { role: "teacher", isManager: false });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});