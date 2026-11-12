/**
 * Access-control tests for expenses (Phase 3) — ADMIN ONLY everywhere:
 * - API: every expense route requires isLoggedIn + isAdmin (DB-resolved role),
 *   never isAdminOrManager — managers never see expense heads, entries or totals.
 * - Views: every expense page/action rejects managers, regular teachers,
 *   students, parents and suspended managers; admin passes.
 *
 * Mirrors __tests__/teacherSalaryAccess.test.js. Middleware identity is asserted
 * on the actual router stack; view guards are exercised with mock req/res — no
 * token/cookie claim is trusted.
 */

const isLoggedIn = require("../middlewares/isLoggedIn");
const isAdminOrManager = require("../middlewares/isAdminOrManager");
const isAdmin = require("../middlewares/isAdmin");

const apiRouter = require("../routes/v1/expenses/expenses.router");
const viewRouter = require("../routes/views/expenses.views");

// ── helpers ───────────────────────────────────────────────────────────────────

function apiRoute(path, method) {
  const layer = apiRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) return null;
  return layer.route.stack
    .filter((s) => !s.method || s.method === method)
    .map((s) => s.handle);
}

function viewGuard(path, method) {
  const layer = viewRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
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

describe("API router wiring — every expense route is ADMIN ONLY", () => {
  it.each([
    ["/expense-heads", "get"],
    ["/expense-heads", "post"],
    ["/expense-heads/:id/toggle", "put"],
    ["/expense-entries", "get"],
    ["/expense-entries", "post"],
  ])("%s %s is gated by isLoggedIn + isAdmin (never isAdminOrManager)", (path, method) => {
    const handlers = apiRoute(path, method);
    expect(handlers).not.toBeNull();
    expect(handlers).toContain(isLoggedIn);
    expect(handlers).toContain(isAdmin);
    expect(handlers).not.toContain(isAdminOrManager);
  });
});

// ── View guards (signed-cookie layer) ────────────────────────────────────────

describe("view guards — every expense page/action is ADMIN ONLY", () => {
  const guards = [
    ["GET expenses page", viewGuard("/expenses", "get")],
    ["POST create entry", viewGuard("/expenses/create", "post")],
    ["GET expense heads", viewGuard("/expense-heads", "get")],
    ["POST create head", viewGuard("/expense-heads/create", "post")],
    ["POST toggle head", viewGuard("/expense-heads/:id/toggle", "post")],
  ];

  it.each(guards)("%s allows admin", async (_label, guard) => {
    expect(guard).not.toBeNull();
    const { next, res } = await runGuard(guard, { role: "admin" });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(guards)("%s rejects even a manager (no expense visibility)", async (_label, guard) => {
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
