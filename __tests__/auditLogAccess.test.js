/**
 * Access-control tests for the audit log viewer — ADMIN ONLY everywhere:
 * - API: /audit-logs and /audit-logs/meta require isLoggedIn + isAdmin
 *   (DB-resolved role), never isAdminOrManager — the trail spans finance +
 *   attendance, so managers (who can mark attendance) must never read it.
 * - View: the /audit-logs page rejects managers, regular teachers, students,
 *   parents and suspended managers; admin passes.
 *
 * Mirrors __tests__/expenseAccess.test.js. Middleware identity is asserted on
 * the actual router stack; view guards are exercised with mock req/res — no
 * token/cookie claim is trusted.
 */

const isLoggedIn = require("../middlewares/isLoggedIn");
const isAdminOrManager = require("../middlewares/isAdminOrManager");
const isAdmin = require("../middlewares/isAdmin");

const apiRouter = require("../routes/v1/audit/auditLog.router");
const viewRouter = require("../routes/views/auditLog.views");

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

describe("API router wiring — every audit route is ADMIN ONLY", () => {
  it.each([
    ["/audit-logs", "get"],
    ["/audit-logs/meta", "get"],
  ])("%s %s is gated by isLoggedIn + isAdmin (never isAdminOrManager)", (path, method) => {
    const handlers = apiRoute(path, method);
    expect(handlers).not.toBeNull();
    expect(handlers).toContain(isLoggedIn);
    expect(handlers).toContain(isAdmin);
    expect(handlers).not.toContain(isAdminOrManager);
  });
});

// ── View guard (signed-cookie layer) ─────────────────────────────────────────

describe("view guard — the audit log page is ADMIN ONLY", () => {
  const guard = viewGuard("/audit-logs", "get");

  it("allows admin", async () => {
    expect(guard).not.toBeNull();
    const { next, res } = await runGuard(guard, { role: "admin" });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects even a manager (the trail spans finance)", async () => {
    const { next, res } = await runGuard(guard, { role: "teacher", isManager: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects a regular teacher", async () => {
    const { next, res } = await runGuard(guard, { role: "teacher", isManager: false });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects a SUSPENDED manager", async () => {
    const { next, res } = await runGuard(guard, { role: "teacher", isManager: true, isSuspended: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects students and parents", async () => {
    for (const role of ["student", "parent"]) {
      const { next, res } = await runGuard(guard, { role });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });
});