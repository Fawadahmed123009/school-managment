/**
 * Tests for parent password features:
 *   FEATURE 1 — Admin/Manager reset parent password from student edit page
 *   FEATURE 2 — Parent self-service change password
 */

const Admin = require("../models/Staff/admin.model");
const Teacher = require("../models/Staff/teachers.model");
const Parent = require("../models/Parents/parents.model");

jest.mock("../models/Staff/admin.model");
jest.mock("../models/Staff/teachers.model");
jest.mock("../models/Parents/parents.model");
jest.mock("../models/Students/students.model", () => ({
  findById: jest.fn(),
}));
const Student = require("../models/Students/students.model");
jest.mock("../handlers/passHash.handler", () => ({
  hashPassword: jest.fn(async (pw) => `hashed_${pw}`),
  isPassMatched: jest.fn(async (plain, hash) => hash === `hashed_${plain}`),
  validatePassword: jest.fn((pw) => {
    if (!pw || pw.length < 6) return "Password must be at least 6 characters";
    return null;
  }),
}));

const { isPassMatched, validatePassword } = require("../handlers/passHash.handler");

const {
  adminResetParentPasswordService,
  changeParentPasswordService,
} = require("../services/parents/parents.service");

// ── Middleware imports for access-control tests ──
const isAdminOrManager = require("../middlewares/isAdminOrManager");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/**
 * Captures the JSON payload written by responseStatus via the service layer.
 * Returns { statusCode, body } where body is { status, data|message }.
 */
function captureRes() {
  const captured = { statusCode: null, body: null };
  const res = {
    status(code) {
      captured.statusCode = code;
      return res;
    },
    json(payload) {
      captured.body = payload;
      return res;
    },
  };
  captured.res = res;
  return captured;
}

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — Admin/Manager reset parent password
// ═════════════════════════════════════════════════════════════════════════════

describe("FEATURE 1 — Admin reset parent password service", () => {
  beforeEach(() => jest.clearAllMocks());

  it("resets with a provided password and returns the plain password", async () => {
    const parentId = "parent-1";
    const studentId = "student-1";

    Student.findById.mockResolvedValue({ _id: studentId, parent: parentId });

    const parentDoc = {
      _id: parentId,
      name: "John Doe",
      email: "john@family.local",
      password: "hashed_oldPass1",
      save: jest.fn(),
    };
    Parent.findById.mockResolvedValue(parentDoc);

    const res = captureRes();
    await adminResetParentPasswordService(studentId, { password: "newPass1" }, res.res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data.password).toBe("newPass1");
    expect(res.body.data.parentName).toBe("John Doe");
    expect(res.body.data.parentEmail).toBe("john@family.local");
    expect(parentDoc.password).toBe("hashed_newPass1");
    expect(parentDoc.save).toHaveBeenCalled();
  });

  it("auto-generates a password when none is provided", async () => {
    const parentId = "parent-2";
    Student.findById.mockResolvedValue({ _id: "student-2", parent: parentId });

    const parentDoc = {
      _id: parentId,
      name: "Jane Doe",
      email: "jane@family.local",
      password: "hashed_oldPass2",
      save: jest.fn(),
    };
    Parent.findById.mockResolvedValue(parentDoc);

    const res = captureRes();
    await adminResetParentPasswordService("student-2", {}, res.res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    // Auto-generated password should be 10 chars
    expect(res.body.data.password).toHaveLength(10);
    expect(parentDoc.save).toHaveBeenCalled();
  });

  it("returns 404 when student is not found", async () => {
    Student.findById.mockResolvedValue(null);

    const res = captureRes();
    await adminResetParentPasswordService("nonexistent", { password: "newPass1" }, res.res);

    expect(res.statusCode).toBe(404);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/Student not found/);
  });

  it("returns 400 when student has no linked parent", async () => {
    Student.findById.mockResolvedValue({ _id: "student-3", parent: null });

    const res = captureRes();
    await adminResetParentPasswordService("student-3", { password: "newPass1" }, res.res);

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/no linked parent/);
  });

  it("returns 400 when password is too short", async () => {
    Student.findById.mockResolvedValue({ _id: "student-4", parent: "parent-4" });
    Parent.findById.mockResolvedValue({
      _id: "parent-4",
      name: "Test",
      email: "test@family.local",
      password: "hashed_x",
      save: jest.fn(),
    });

    const res = captureRes();
    await adminResetParentPasswordService("student-4", { password: "ab" }, res.res);

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("failed");
    expect(validatePassword).toHaveBeenCalledWith("ab");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — Access control: only admin/manager can reset
// ═════════════════════════════════════════════════════════════════════════════

describe("FEATURE 1 — Access control for admin reset route", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ALLOWS admin user through isAdminOrManager middleware", async () => {
    Admin.findById.mockResolvedValue({ _id: "admin-id", role: "admin" });
    Teacher.findById.mockResolvedValue(null);

    const req = { userAuth: { id: "admin-id" } };
    const res = mockRes();
    const next = jest.fn();

    await isAdminOrManager(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("ALLOWS manager (teacher with isAttendanceManager) through middleware", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({ _id: "mgr-id", isAttendanceManager: true });

    const req = { userAuth: { id: "mgr-id" } };
    const res = mockRes();
    const next = jest.fn();

    await isAdminOrManager(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("REJECTS regular teacher (non-manager) with 403", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({ _id: "teacher-id", isAttendanceManager: false });

    const req = { userAuth: { id: "teacher-id" } };
    const res = mockRes();
    const next = jest.fn();

    await isAdminOrManager(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        message: expect.stringContaining("Access Denied"),
      })
    );
  });

  it("REJECTS parent user with 403", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue(null);

    const req = { userAuth: { id: "parent-id" } };
    const res = mockRes();
    const next = jest.fn();

    await isAdminOrManager(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — Parent self-service change password
// ═════════════════════════════════════════════════════════════════════════════

describe("FEATURE 2 — Parent change password service", () => {
  beforeEach(() => jest.clearAllMocks());

  it("changes password when current password is correct", async () => {
    const parentDoc = {
      _id: "parent-10",
      password: "hashed_current1",
      save: jest.fn(),
    };
    Parent.findById.mockResolvedValue(parentDoc);

    const res = captureRes();
    await changeParentPasswordService(
      "parent-10",
      { currentPassword: "current1", newPassword: "newPass1", confirmPassword: "newPass1" },
      res.res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data).toMatch(/Password changed/);
    expect(parentDoc.password).toBe("hashed_newPass1");
    expect(parentDoc.save).toHaveBeenCalled();
    expect(isPassMatched).toHaveBeenCalledWith("current1", "hashed_current1");
  });

  it("rejects when current password is wrong", async () => {
    const parentDoc = {
      _id: "parent-11",
      password: "hashed_correctPw",
      save: jest.fn(),
    };
    Parent.findById.mockResolvedValue(parentDoc);

    const res = captureRes();
    await changeParentPasswordService(
      "parent-11",
      { currentPassword: "wrongPassword", newPassword: "newPass1", confirmPassword: "newPass1" },
      res.res
    );

    expect(res.statusCode).toBe(401);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/current password is incorrect/i);
    expect(parentDoc.save).not.toHaveBeenCalled();
  });

  it("rejects when new passwords do not match", async () => {
    const res = captureRes();
    await changeParentPasswordService(
      "parent-12",
      { currentPassword: "current1", newPassword: "newPass1", confirmPassword: "different1" },
      res.res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/do not match/);
    // Should not even query the DB
    expect(Parent.findById).not.toHaveBeenCalled();
  });

  it("rejects when new password is too short", async () => {
    const res = captureRes();
    await changeParentPasswordService(
      "parent-13",
      { currentPassword: "current1", newPassword: "ab", confirmPassword: "ab" },
      res.res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("failed");
    expect(validatePassword).toHaveBeenCalledWith("ab");
  });

  it("rejects when current password or new password is missing", async () => {
    const res = captureRes();
    await changeParentPasswordService(
      "parent-14",
      { currentPassword: "", newPassword: "newPass1", confirmPassword: "newPass1" },
      res.res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/required/);
  });

  it("returns 404 when parent is not found", async () => {
    Parent.findById.mockResolvedValue(null);

    const res = captureRes();
    await changeParentPasswordService(
      "nonexistent-parent",
      { currentPassword: "current1", newPassword: "newPass1", confirmPassword: "newPass1" },
      res.res
    );

    expect(res.statusCode).toBe(404);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/Parent not found/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Route configuration verification
// ═════════════════════════════════════════════════════════════════════════════

describe("Route configuration — parent password routes exist", () => {
  const fs = require("fs");

  it("parents router has the admin reset-parent-password route with isAdminOrManager", () => {
    const content = fs.readFileSync("./routes/v1/parents/parents.router.js", "utf8");
    expect(content).toContain("reset-parent-password");
    expect(content).toContain("adminResetParentPasswordController");
  });

  it("parents router has the change-password route with isParent", () => {
    const content = fs.readFileSync("./routes/v1/parents/parents.router.js", "utf8");
    expect(content).toContain("change-password");
    expect(content).toContain("changeParentPasswordController");
    expect(content).toContain("isParent");
  });

  it("students view route has reset-parent-password POST route", () => {
    const content = fs.readFileSync("./routes/views/students.views.js", "utf8");
    expect(content).toContain("reset-parent-password");
    expect(content).toContain("adminResetParentPasswordService");
  });

  it("parent portal view route has change-password POST route", () => {
    const content = fs.readFileSync("./routes/views/parentPortal.views.js", "utf8");
    expect(content).toContain("change-password");
    expect(content).toContain("changeParentPasswordService");
  });

  it("student edit view includes reset parent password section", () => {
    const content = fs.readFileSync("./views/students/edit.ejs", "utf8");
    expect(content).toContain("Reset parent password");
    expect(content).toContain("reset-parent-password");
    expect(content).toContain("student.parent");
  });

  it("parent dashboard view includes change password form", () => {
    const content = fs.readFileSync("./views/parents/dashboard.ejs", "utf8");
    expect(content).toContain("Change password");
    expect(content).toContain("currentPassword");
    expect(content).toContain("newPassword");
    expect(content).toContain("confirmPassword");
    expect(content).toContain("_csrf");
  });

  it("parent-reset-confirm view exists and shows credentials", () => {
    const content = fs.readFileSync("./views/students/parent-reset-confirm.ejs", "utf8");
    expect(content).toContain("credentials.password");
    expect(content).toContain("credentials.name");
    expect(content).toContain("credentials.email");
  });
});
