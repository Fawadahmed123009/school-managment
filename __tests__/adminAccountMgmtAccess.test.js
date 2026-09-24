/**
 * C1 — Admin-account management must be full-admin ONLY.
 *
 * A manager (teacher with isAttendanceManager=true) has admin-like access to
 * most routes, but must NEVER create, edit, or delete admin accounts.
 * These tests lock GET /admins, /admin/register, PUT /admin/:adminId and
 * DELETE /admin/:adminId to the strict `isAdmin` middleware (not
 * `isAdminOrManager`).
 */

const fs = require("fs");
const path = require("path");

const isAdmin = require("../middlewares/isAdmin");
const Admin = require("../models/Staff/admin.model");
const Teacher = require("../models/Staff/teachers.model");

jest.mock("../models/Staff/admin.model");
jest.mock("../models/Staff/teachers.model");

const ROUTER_FILE = path.join(
  __dirname,
  "..",
  "routes",
  "v1",
  "staff",
  "admin.router.js"
);

// \bisAdmin\b never matches inside "isAdminOrManager" (no word boundary
// between "isAdmin" and "OrManager"), so these assertions are unambiguous.
function blockFor(routeRegex) {
  const content = fs.readFileSync(ROUTER_FILE, "utf8");
  const m = content.match(routeRegex);
  if (!m) throw new Error(`Could not locate route block for ${routeRegex}`);
  return m[0];
}

describe("C1 — admin.router.js route configuration", () => {
  it("GET /admins (admin roster) uses isAdmin, not isAdminOrManager", () => {
    // Roster reads (names/emails/roles) are reconnaissance for the very
    // escalation path the write routes above close.
    const block = blockFor(/\.route\("\/admins"\)\.get\([^)]*\);/);
    expect(block).toMatch(/\.get\(isLoggedIn,\s*isAdmin,\s*getAdminsController\)/);
    expect(block).not.toMatch(/isAdminOrManager/);
  });

  it("POST /admin/register uses isAdmin, not isAdminOrManager", () => {
    const block = blockFor(/\.route\("\/admin\/register"\)[\s\S]*?;/);
    expect(block).toMatch(/\bisAdmin\b/);
    expect(block).not.toMatch(/isAdminOrManager/);
  });

  it("PUT + DELETE /admin/:adminId use isAdmin, not isAdminOrManager", () => {
    const block = blockFor(
      /\.route\("\/admin\/:adminId"\)[\s\S]*?deleteAdminController\);/
    );
    expect(block).toMatch(/\.put\(isLoggedIn,\s*isAdmin,\s*updateAdminController\)/);
    expect(block).toMatch(
      /\.delete\(isLoggedIn,\s*isAdmin,\s*deleteAdminController\)/
    );
    expect(block).not.toMatch(/isAdminOrManager/);
  });
});

describe("C1 — isAdmin middleware actually denies managers on admin-account ops", () => {
  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = { userAuth: { id: "test-user-id" } };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
  });

  it("REJECTS a manager (teacher with isAttendanceManager=true)", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({ _id: "t", isAttendanceManager: true });

    await isAdmin(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(403);
  });

  it("REJECTS a non-'admin' role admin record", async () => {
    Admin.findById.mockResolvedValue({ _id: "a", role: "staff" });

    await isAdmin(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(403);
  });

  it("ALLOWS a full admin (role === 'admin')", async () => {
    Admin.findById.mockResolvedValue({ _id: "a", role: "admin" });

    await isAdmin(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });
});
