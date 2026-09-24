/**
 * Admin password policy enforcement.
 *
 * The weak-admin-credential root cause was that admin create/update wrote
 * straight to hashPassword() without ever consulting the shared policy
 * (validatePassword) that parent password flows already use. These tests lock
 * the enforcement in: any future refactor that drops the check fails here.
 *
 * The real validatePassword is used (only hashPassword is stubbed) so the
 * tests prove the actual policy is applied, not a mock's behaviour.
 */

const Admin = require("../models/Staff/admin.model");

jest.mock("../models/Staff/admin.model");

jest.mock("../handlers/passHash.handler", () => {
  const actual = jest.requireActual("../handlers/passHash.handler");
  return {
    ...actual,
    hashPassword: jest.fn(async (pw) => `hashed_${pw}`),
    isPassMatched: jest.fn(async (plain, hash) => hash === `hashed_${plain}`),
  };
});

const {
  registerAdminService,
  updateAdminService,
} = require("../services/staff/admin.service");

// ── Helpers ──────────────────────────────────────────────────────────────────

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

beforeEach(() => {
  jest.clearAllMocks();
  Admin.findOne.mockResolvedValue(null);
  Admin.findById.mockResolvedValue({ _id: "admin1", role: "admin" });
  Admin.create.mockResolvedValue({});
  // The service chains .select() onto findByIdAndUpdate(), so the stub has to
  // be a thenable with a chainable .select().
  Admin.findByIdAndUpdate.mockImplementation(() => {
    const thenable = Promise.resolve({ _id: "admin1", name: "Admin" });
    thenable.select = () => thenable;
    return thenable;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// registerAdminService
// ═════════════════════════════════════════════════════════════════════════════

describe("registerAdminService — password policy", () => {
  it("rejects a missing password and never writes to the DB", async () => {
    const ctx = captureRes();
    await registerAdminService({ name: "Admin", email: "a@b.com" }, ctx.res);

    expect(ctx.statusCode).toBe(400);
    expect(ctx.body.status).toBe("failed");
    expect(Admin.create).not.toHaveBeenCalled();
    expect(Admin.findOne).not.toHaveBeenCalled();
  });

  it("rejects a password shorter than the policy minimum", async () => {
    const ctx = captureRes();
    await registerAdminService(
      { name: "Admin", email: "a@b.com", password: "ab1" },
      ctx.res
    );

    expect(ctx.statusCode).toBe(400);
    expect(ctx.body.message).toContain("at least 6 characters");
    expect(Admin.create).not.toHaveBeenCalled();
  });

  it("rejects a password with no number", async () => {
    const ctx = captureRes();
    await registerAdminService(
      { name: "Admin", email: "a@b.com", password: "abcdefgh" },
      ctx.res
    );

    expect(ctx.statusCode).toBe(400);
    expect(ctx.body.message).toContain("letter and one number");
    expect(Admin.create).not.toHaveBeenCalled();
  });

  it("rejects the historically weak bootstrap value", async () => {
    const ctx = captureRes();
    await registerAdminService(
      { name: "Admin", email: "a@b.com", password: "123456" },
      ctx.res
    );

    expect(ctx.statusCode).toBe(400);
    expect(Admin.create).not.toHaveBeenCalled();
  });

  it("validates the password before the email-uniqueness lookup", async () => {
    // A duplicate email must not mask the policy failure.
    Admin.findOne.mockResolvedValue({ _id: "existing", email: "a@b.com" });
    const ctx = captureRes();
    await registerAdminService(
      { name: "Admin", email: "a@b.com", password: "x" },
      ctx.res
    );

    expect(ctx.statusCode).toBe(400);
    expect(Admin.findOne).not.toHaveBeenCalled();
  });

  it("accepts a policy-compliant password", async () => {
    const ctx = captureRes();
    await registerAdminService(
      { name: "Admin", email: "a@b.com", password: "abc123" },
      ctx.res
    );

    expect(ctx.statusCode).toBe(201);
    expect(Admin.create).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// updateAdminService
// ═════════════════════════════════════════════════════════════════════════════

describe("updateAdminService — password policy", () => {
  it("rejects a weak replacement password without persisting it", async () => {
    const ctx = captureRes();
    await updateAdminService(
      "admin1",
      { name: "Admin", email: "a@b.com", password: "123456" },
      ctx.res
    );

    expect(ctx.statusCode).toBe(400);
    expect(ctx.body.status).toBe("failed");
    expect(Admin.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only password instead of storing it", async () => {
    const ctx = captureRes();
    await updateAdminService(
      "admin1",
      { name: "Admin", password: "   " },
      ctx.res
    );

    // "   " is truthy, so it reaches the policy check and is rejected
    // instead of being stored as a whitespace admin password.
    expect(ctx.statusCode).toBe(400);
    expect(Admin.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("persists a policy-compliant password", async () => {
    const ctx = captureRes();
    await updateAdminService(
      "admin1",
      { name: "Admin", email: "a@b.com", password: "Str0ngPass1" },
      ctx.res
    );

    expect(ctx.statusCode).toBe(200);
    expect(Admin.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    const payload = Admin.findByIdAndUpdate.mock.calls[0][1];
    expect(payload.password).toBe("hashed_Str0ngPass1");
  });

  it("still allows profile-only edits (no password field)", async () => {
    const ctx = captureRes();
    await updateAdminService(
      "admin1",
      { name: "Renamed", email: "new@b.com" },
      ctx.res
    );

    expect(ctx.statusCode).toBe(200);
    expect(Admin.findByIdAndUpdate).toHaveBeenCalledTimes(1);
  });
});
