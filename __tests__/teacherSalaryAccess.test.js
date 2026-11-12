/**
 * Access-control tests for teacher salary (Phase 2) — ADMIN ONLY everywhere:
 * - API: every salary route requires isLoggedIn + isAdmin (DB-resolved role),
 *   never isAdminOrManager — managers keep only their Phase 1 attendance surface.
 * - Views: every salary page/action rejects managers, regular teachers,
 *   students, parents and suspended managers; admin passes.
 *
 * Middleware identity is asserted on the actual router stack, and the view
 * guards are exercised with mock req/res — no token/cookie claim is trusted.
 */

const isLoggedIn = require("../middlewares/isLoggedIn");
const isAdminOrManager = require("../middlewares/isAdminOrManager");
const isAdmin = require("../middlewares/isAdmin");

const apiRouter = require("../routes/v1/staff/teacherSalary.router");
const viewRouter = require("../routes/views/teacherSalary.views");

// ── helpers ───────────────────────────────────────────────────────────────────

function apiRoute(path, method) {
  const layer = apiRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) return null;
  // GET+POST/DELETE share one route object on the same path — keep only the
  // layers registered for the method under test.
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

describe("API router wiring — every salary route is ADMIN ONLY", () => {
  it.each([
    ["/teacher-salary/configs", "get"],
    ["/teacher-salary/configs", "post"],
    ["/teacher-salary/settings", "get"],
    ["/teacher-salary/settings", "put"],
    ["/teacher-salary/preview", "post"],
    ["/teacher-salary/runs", "get"],
    ["/teacher-salary/runs", "post"],
    ["/teacher-salary/runs/:id", "get"],
    ["/teacher-salary/runs/:id", "delete"],
    ["/teacher-salary/runs/:id/finalize", "put"],
  ])("%s %s is gated by isLoggedIn + isAdmin (never isAdminOrManager)", (path, method) => {
    const handlers = apiRoute(path, method);
    expect(handlers).not.toBeNull();
    expect(handlers).toContain(isLoggedIn);
    expect(handlers).toContain(isAdmin);
    expect(handlers).not.toContain(isAdminOrManager);
  });
});

// ── View guards (signed-cookie layer) ────────────────────────────────────────

describe("view guards — every salary page/action is ADMIN ONLY", () => {
  const guards = [
    ["GET runs page", viewGuard("/teacher-salary", "get")],
    ["POST preview proxy", viewGuard("/teacher-salary/preview", "post")],
    ["POST generate", viewGuard("/teacher-salary/generate", "post")],
    ["GET run detail", viewGuard("/teacher-salary/runs/:id", "get")],
    ["POST finalize", viewGuard("/teacher-salary/runs/:id/finalize", "post")],
    ["POST delete draft", viewGuard("/teacher-salary/runs/:id/delete", "post")],
    ["GET config page", viewGuard("/teacher-salary/config", "get")],
    ["POST rate", viewGuard("/teacher-salary/config/rate", "post")],
    ["POST deduction settings", viewGuard("/teacher-salary/config/settings", "post")],
  ];

  it.each(guards)("%s allows admin", async (_label, guard) => {
    expect(guard).not.toBeNull();
    const { next, res } = await runGuard(guard, { role: "admin" });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(guards)("%s rejects even a manager (no pay visibility)", async (_label, guard) => {
    const { next, res } = await runGuard(guard, { role: "teacher", isManager: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
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