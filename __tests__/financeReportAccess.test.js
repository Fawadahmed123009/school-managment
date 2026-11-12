/**
 * Access-control tests for Phase 4 financial reports — ADMIN ONLY everywhere:
 * - API: /finance-report (and the existing /net-summary) require isLoggedIn +
 *   isAdmin (DB-resolved role), never isAdminOrManager — managers never see
 *   financial reports, mirroring Expenses/Income/Salary.
 * - Views: all three report pages reject managers, regular teachers, students,
 *   parents and suspended managers; admin passes.
 *
 * Mirrors __tests__/expenseAccess.test.js. Middleware identity is asserted on
 * the actual router stack; view guards are exercised with mock req/res — no
 * token/cookie claim is trusted.
 */

const isLoggedIn = require("../middlewares/isLoggedIn");
const isAdminOrManager = require("../middlewares/isAdminOrManager");
const isAdmin = require("../middlewares/isAdmin");

const apiRouter = require("../routes/v1/finance/finance.router");
const viewRouter = require("../routes/views/financeReport.views");

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

describe("API router wiring — finance report routes are ADMIN ONLY", () => {
  it.each([
    ["/finance-report", "get"],
    ["/net-summary", "get"],
  ])("%s %s is gated by isLoggedIn + isAdmin (never isAdminOrManager)", (path, method) => {
    const handlers = apiRoute(path, method);
    expect(handlers).not.toBeNull();
    expect(handlers).toContain(isLoggedIn);
    expect(handlers).toContain(isAdmin);
    expect(handlers).not.toContain(isAdminOrManager);
  });

  it("the report API exposes no write methods (read-only phase)", () => {
    const layer = apiRouter.stack.find((l) => l.route && l.route.path === "/finance-report");
    expect(layer).toBeTruthy();
    expect(Object.keys(layer.route.methods).sort()).toEqual(["get"]);
  });
});

// ── View guards (signed-cookie layer) ────────────────────────────────────────

describe("view guards — every finance report page is ADMIN ONLY", () => {
  const guards = [
    ["GET daily report", viewGuard("/finance/daily-report", "get")],
    ["GET monthly report", viewGuard("/finance/monthly-report", "get")],
    ["GET yearly report", viewGuard("/finance/yearly-report", "get")],
  ];

  it.each(guards)("%s allows admin", async (_label, guard) => {
    expect(guard).not.toBeNull();
    const { next, res } = await runGuard(guard, { role: "admin" });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(guards)("%s rejects even a manager (no financial visibility)", async (_label, guard) => {
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

  it("no write routes exist on the report view router (read-only phase)", () => {
    const writeLayers = viewRouter.stack.filter(
      (l) => l.route && (l.route.methods.post || l.route.methods.put || l.route.methods.delete)
    );
    expect(writeLayers).toHaveLength(0);
  });
});
