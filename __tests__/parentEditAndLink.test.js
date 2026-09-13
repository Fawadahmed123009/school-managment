/**
 * Tests for student edit page parent features:
 *   FEATURE 1 — Edit existing linked parent's basic fields (email, name, phone, relationship)
 *   FEATURE 2 — Add parent details to a student with no linked parent (reuses family-match)
 */

const Admin = require("../models/Staff/admin.model");
const Teacher = require("../models/Staff/teachers.model");
const Parent = require("../models/Parents/parents.model");

jest.mock("../models/Staff/admin.model");
jest.mock("../models/Staff/teachers.model");
jest.mock("../models/Parents/parents.model", () => {
  // Build a chainable mock query that supports .populate(), .sort(), .select()
  const chainable = (resolveValue) => {
    const obj = {
      populate: jest.fn(),
      sort: jest.fn(),
      select: jest.fn(),
    };
    // Each chain method returns the next chain link, ultimately resolving as a promise
    obj.populate.mockReturnValue({ sort: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(resolveValue) }) });
    obj.sort.mockReturnValue({ select: jest.fn().mockResolvedValue(resolveValue) });
    obj.select.mockResolvedValue(resolveValue);
    // Make it thenable so `await Parent.findOne(...)` works
    obj.then = (resolve) => Promise.resolve(resolveValue).then(resolve);
    return obj;
  };

  return {
    findById: jest.fn(),
    findOne: jest.fn(() => chainable(null)),
    findByIdAndUpdate: jest.fn(() => ({
      select: jest.fn().mockResolvedValue(null),
    })),
    create: jest.fn(),
  };
});
jest.mock("../models/Students/students.model", () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
const Student = require("../models/Students/students.model");

jest.mock("../handlers/passHash.handler", () => ({
  hashPassword: jest.fn(async (pw) => `hashed_${pw}`),
  isPassMatched: jest.fn(async (plain, hash) => hash === `hashed_${plain}`),
}));

const isAdminOrManager = require("../middlewares/isAdminOrManager");

const {
  updateLinkedParentService,
  addParentToStudentService,
} = require("../services/students/students.service");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

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
// FEATURE 1 — Update linked parent's basic info
// ═════════════════════════════════════════════════════════════════════════════

describe("FEATURE 1 — Update linked parent service", () => {
  beforeEach(() => jest.clearAllMocks());

  it("updates parent email successfully", async () => {
    const parentId = "parent-1";
    Student.findById.mockResolvedValue({ _id: "student-1", parent: parentId });

    const parentDoc = {
      _id: parentId,
      name: "John Doe",
      email: "old@family.local",
      phone: "03001234567",
      relationship: "father",
    };
    Parent.findById.mockResolvedValue(parentDoc);
    // Email uniqueness check: findOne returns null (not taken)
    Parent.findOne.mockReturnValue({ then: (resolve) => Promise.resolve(null).then(resolve) });
    const updatedParent = { ...parentDoc, email: "new@family.local" };
    Parent.findByIdAndUpdate.mockReturnValue({ select: jest.fn().mockResolvedValue(updatedParent) });

    const res = captureRes();
    await updateLinkedParentService("student-1", { parentEmail: "new@family.local" }, res.res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    expect(Parent.findByIdAndUpdate).toHaveBeenCalledWith(
      parentId,
      { $set: { email: "new@family.local" } },
      { new: true }
    );
  });

  it("updates multiple parent fields at once", async () => {
    const parentId = "parent-2";
    Student.findById.mockResolvedValue({ _id: "student-2", parent: parentId });
    Parent.findById.mockResolvedValue({
      _id: parentId,
      name: "Old Name",
      email: "old@family.local",
      phone: "03001234567",
      relationship: "father",
    });
    // Email uniqueness check: findOne returns null (not taken)
    Parent.findOne.mockReturnValue({ then: (resolve) => Promise.resolve(null).then(resolve) });
    const updatedDoc = {
      _id: parentId,
      name: "New Name",
      email: "new@family.local",
      phone: "03009999999",
      relationship: "mother",
    };
    Parent.findByIdAndUpdate.mockReturnValue({ select: jest.fn().mockResolvedValue(updatedDoc) });

    const res = captureRes();
    await updateLinkedParentService(
      "student-2",
      {
        parentName: "New Name",
        parentEmail: "new@family.local",
        parentPhone: "03009999999",
        relationship: "mother",
      },
      res.res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    const updateCall = Parent.findByIdAndUpdate.mock.calls[0];
    expect(updateCall[1].$set).toEqual({
      name: "New Name",
      email: "new@family.local",
      phone: "03009999999",
      relationship: "mother",
    });
  });

  it("rejects duplicate email with 409", async () => {
    const parentId = "parent-3";
    Student.findById.mockResolvedValue({ _id: "student-3", parent: parentId });
    Parent.findById.mockResolvedValue({
      _id: parentId,
      email: "original@family.local",
    });
    Parent.findOne.mockResolvedValue({ _id: "other-parent" }); // email taken

    const res = captureRes();
    await updateLinkedParentService("student-3", { parentEmail: "taken@family.local" }, res.res);

    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/already used by another parent/);
  });

  it("rejects invalid email format with 400", async () => {
    const parentId = "parent-4";
    Student.findById.mockResolvedValue({ _id: "student-4", parent: parentId });
    Parent.findById.mockResolvedValue({ _id: parentId, email: "valid@family.local" });

    const res = captureRes();
    await updateLinkedParentService("student-4", { parentEmail: "not-an-email" }, res.res);

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/Invalid email format/);
  });

  it("rejects invalid relationship value with 400", async () => {
    const parentId = "parent-5";
    Student.findById.mockResolvedValue({ _id: "student-5", parent: parentId });
    Parent.findById.mockResolvedValue({ _id: parentId, email: "valid@family.local" });

    const res = captureRes();
    await updateLinkedParentService("student-5", { relationship: "cousin" }, res.res);

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/Relationship must be/);
  });

  it("returns 404 when student not found", async () => {
    Student.findById.mockResolvedValue(null);

    const res = captureRes();
    await updateLinkedParentService("nonexistent", { parentName: "Test" }, res.res);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/Student not found/);
  });

  it("returns 400 when student has no linked parent", async () => {
    Student.findById.mockResolvedValue({ _id: "student-6", parent: null });

    const res = captureRes();
    await updateLinkedParentService("student-6", { parentName: "Test" }, res.res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/no linked parent/);
  });

  it("returns 400 when no fields to update", async () => {
    const parentId = "parent-7";
    Student.findById.mockResolvedValue({ _id: "student-7", parent: parentId });
    Parent.findById.mockResolvedValue({ _id: parentId, email: "valid@family.local" });

    const res = captureRes();
    await updateLinkedParentService("student-7", {}, res.res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/No fields to update/);
  });

  it("does NOT trigger family matching when phone is changed", async () => {
    // This is a critical test: updating parent phone should just update the field,
    // not search for matching parents or re-run family-match logic.
    const parentId = "parent-8";
    Student.findById.mockResolvedValue({ _id: "student-8", parent: parentId });
    Parent.findById.mockResolvedValue({
      _id: parentId,
      name: "John",
      email: "john@family.local",
      phone: "03001111111",
      relationship: "father",
    });
    Parent.findByIdAndUpdate.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: parentId, phone: "03002222222" }),
    });

    const res = captureRes();
    await updateLinkedParentService("student-8", { parentPhone: "03002222222" }, res.res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    // Verify Parent.findOne was NOT called (no family matching)
    expect(Parent.findOne).not.toHaveBeenCalled();
  });

  it("allows same email as current (no uniqueness error)", async () => {
    const parentId = "parent-9";
    Student.findById.mockResolvedValue({ _id: "student-9", parent: parentId });
    const parentDoc = { _id: parentId, email: "same@family.local", name: "Test" };
    Parent.findById.mockResolvedValue(parentDoc);
    Parent.findByIdAndUpdate.mockReturnValue({ select: jest.fn().mockResolvedValue(parentDoc) });

    const res = captureRes();
    await updateLinkedParentService("student-9", { parentEmail: "same@family.local" }, res.res);

    // Should NOT check uniqueness since email is unchanged
    expect(Parent.findOne).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — Add parent details to unlinked student
// ═════════════════════════════════════════════════════════════════════════════

describe("FEATURE 2 — Add parent to unlinked student service", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns confirm status when phone matches existing parent", async () => {
    Student.findById.mockResolvedValue({
      _id: "student-10",
      parent: null,
      whatsappNumber: "03001234567",
      fatherName: "Test Father",
    });

    const existingParent = {
      _id: "existing-parent",
      name: "Existing Parent",
      phone: "03001234567",
      familyNumber: "FAM-1001",
      children: [],
    };
    Parent.findOne.mockReturnValue({
      populate: jest.fn().mockResolvedValue(existingParent),
    });

    const res = captureRes();
    await addParentToStudentService(
      "student-10",
      { parentPhone: "03001234567", parentName: "Test Parent" },
      res.res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("confirm");
    expect(res.body.data.matchedParent._id).toBe("existing-parent");
    expect(res.body.data.matchedParent.familyNumber).toBe("FAM-1001");
  });

  it("returns confirm status when email matches existing parent", async () => {
    Student.findById.mockResolvedValue({
      _id: "student-11",
      parent: null,
      whatsappNumber: "03009999999",
      fatherName: "Test Father",
    });

    const existingParent = {
      _id: "email-parent",
      name: "Email Parent",
      phone: "03008888888",
      email: "parent@school.com",
      familyNumber: "FAM-1002",
      children: [{ name: "Sibling", rollNumber: "5", fatherName: "Test Father" }],
    };
    // First call (phone) returns null, second call (email) returns match
    Parent.findOne
      .mockReturnValueOnce({ populate: jest.fn().mockResolvedValue(null) })
      .mockReturnValueOnce({ populate: jest.fn().mockResolvedValue(existingParent) });

    const res = captureRes();
    await addParentToStudentService(
      "student-11",
      { parentEmail: "parent@school.com", parentName: "Test Parent" },
      res.res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("confirm");
    expect(res.body.data.matchedParent._id).toBe("email-parent");
  });

  it("creates new parent when no match found", async () => {
    Student.findById.mockResolvedValue({
      _id: "student-12",
      parent: null,
      whatsappNumber: "03001111111",
      fatherName: "New Father",
    });
    Student.findByIdAndUpdate.mockResolvedValue({});

    // Use the chainable mock that supports both .populate() and .sort().select()
    Parent.findOne.mockReturnValue({
      populate: jest.fn().mockResolvedValue(null),
      sort: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(null) }),
      then: (resolve) => Promise.resolve(null).then(resolve),
    }); // no match
    // generateFamilyNumber also calls Parent.findOne with .sort().select()
    // The default mock already supports chaining; just ensure it resolves null for the family-number query
    Parent.create.mockResolvedValue({
      _id: "new-parent-id",
      name: "New Parent",
      email: "newparent@family.local",
      phone: "03001111111",
      familyNumber: "FAM-1003",
    });
    Parent.findByIdAndUpdate.mockReturnValue({ select: jest.fn().mockResolvedValue({}) });

    const res = captureRes();
    await addParentToStudentService(
      "student-12",
      { parentName: "New Parent", parentEmail: "newparent@family.local", parentPhone: "03001111111" },
      res.res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data.familyNumber).toBe("FAM-1001");
    expect(res.body.data.parent).toBe("new-parent-id");
    expect(res.body.data.newParentCredentials).toBeDefined();
    expect(res.body.data.newParentCredentials.password).toBeDefined();

    // Verify student was linked
    expect(Student.findByIdAndUpdate).toHaveBeenCalledWith("student-12", {
      $set: { familyNumber: "FAM-1001", parent: "new-parent-id" },
    });
    // Verify parent's children array was updated
    expect(Parent.findByIdAndUpdate).toHaveBeenCalledWith("new-parent-id", {
      $push: { children: "student-12" },
    });
  });

  it("links to existing parent when familyAction is 'link'", async () => {
    Student.findById.mockResolvedValue({
      _id: "student-13",
      parent: null,
      whatsappNumber: "03001234567",
      fatherName: "Father",
    });
    Student.findByIdAndUpdate.mockResolvedValue({});

    const existingParent = {
      _id: "link-parent",
      name: "Link Parent",
      phone: "03001234567",
      familyNumber: "FAM-1004",
      children: [],
    };
    Parent.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(existingParent) });
    Parent.findByIdAndUpdate.mockReturnValue({ select: jest.fn().mockResolvedValue({}) });

    const res = captureRes();
    await addParentToStudentService(
      "student-13",
      { parentPhone: "03001234567", parentName: "Link Parent", familyAction: "link" },
      res.res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data.familyNumber).toBe("FAM-1004");
    expect(res.body.data.parent).toBe("link-parent");
    // No new parent credentials since we linked to existing
    expect(res.body.data.newParentCredentials).toBeUndefined();
  });

  it("creates new family when familyAction is 'new' despite match", async () => {
    Student.findById.mockResolvedValue({
      _id: "student-14",
      parent: null,
      whatsappNumber: "03001234567",
      fatherName: "Father",
    });
    Student.findByIdAndUpdate.mockResolvedValue({});

    const existingParent = {
      _id: "existing-parent-2",
      name: "Existing",
      phone: "03001234567",
      familyNumber: "FAM-1005",
      children: [],
    };
    Parent.findOne
      .mockReturnValueOnce({
        populate: jest.fn().mockResolvedValue(existingParent),
        sort: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(null) }),
        then: (resolve) => Promise.resolve(existingParent).then(resolve),
      })
      .mockReturnValue({
        populate: jest.fn().mockResolvedValue(null),
        sort: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue(null) }),
        then: (resolve) => Promise.resolve(null).then(resolve),
      });
    Parent.create.mockResolvedValue({
      _id: "brand-new-parent",
      name: "Father",
      email: "03001234567@family.local",
      phone: "03001234567",
      familyNumber: "FAM-1006",
    });
    Parent.findByIdAndUpdate.mockReturnValue({ select: jest.fn().mockResolvedValue({}) });

    const res = captureRes();
    await addParentToStudentService(
      "student-14",
      { parentPhone: "03001234567", parentName: "Father", familyAction: "new" },
      res.res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data.familyNumber).toBe("FAM-1001");
    expect(res.body.data.parent).toBe("brand-new-parent");
    expect(res.body.data.newParentCredentials).toBeDefined();
  });

  it("returns 400 when student already has a linked parent", async () => {
    Student.findById.mockResolvedValue({
      _id: "student-15",
      parent: "existing-parent-id",
    });

    const res = captureRes();
    await addParentToStudentService(
      "student-15",
      { parentName: "Test", parentPhone: "03001111111" },
      res.res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("failed");
    expect(res.body.message).toMatch(/already has a linked parent/);
  });

  it("returns 404 when student not found", async () => {
    Student.findById.mockResolvedValue(null);

    const res = captureRes();
    await addParentToStudentService("nonexistent", { parentName: "Test" }, res.res);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/Student not found/);
  });

  it("returns 400 when no parent details provided", async () => {
    Student.findById.mockResolvedValue({
      _id: "student-16",
      parent: null,
    });

    const res = captureRes();
    await addParentToStudentService("student-16", {}, res.res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/at least one parent detail/i);
  });

  it("rejects invalid email format with 400", async () => {
    Student.findById.mockResolvedValue({
      _id: "student-17",
      parent: null,
    });

    const res = captureRes();
    await addParentToStudentService(
      "student-17",
      { parentName: "Test", parentEmail: "bad-email", parentPhone: "03001111111" },
      res.res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Invalid email format/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Access control — both features restricted to admin/manager
// ═════════════════════════════════════════════════════════════════════════════

describe("Access control — parent edit/add routes", () => {
  beforeEach(() => jest.clearAllMocks());

  it("ALLOWS admin through isAdminOrManager", async () => {
    Admin.findById.mockResolvedValue({ _id: "admin-id", role: "admin" });
    Teacher.findById.mockResolvedValue(null);

    const req = { userAuth: { id: "admin-id" } };
    const res = mockRes();
    const next = jest.fn();

    await isAdminOrManager(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("ALLOWS manager through isAdminOrManager", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({ _id: "mgr-id", isAttendanceManager: true });

    const req = { userAuth: { id: "mgr-id" } };
    const res = mockRes();
    const next = jest.fn();

    await isAdminOrManager(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("REJECTS regular teacher with 403", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({ _id: "teacher-id", isAttendanceManager: false });

    const req = { userAuth: { id: "teacher-id" } };
    const res = mockRes();
    const next = jest.fn();

    await isAdminOrManager(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
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
// Route & view configuration verification
// ═════════════════════════════════════════════════════════════════════════════

describe("Route & view configuration", () => {
  const fs = require("fs");

  it("students router has update-parent route with isAdminOrManager", () => {
    const content = fs.readFileSync("./routes/v1/students/students.router.js", "utf8");
    expect(content).toContain("update-parent");
    expect(content).toContain("updateLinkedParentController");
    expect(content).toContain("isAdminOrManager");
  });

  it("students router has add-parent route with isAdminOrManager", () => {
    const content = fs.readFileSync("./routes/v1/students/students.router.js", "utf8");
    expect(content).toContain("add-parent");
    expect(content).toContain("addParentToStudentController");
  });

  it("students view route has update-parent POST handler", () => {
    const content = fs.readFileSync("./routes/views/students.views.js", "utf8");
    expect(content).toContain("/update-parent");
    expect(content).toContain("updateLinkedParentService");
  });

  it("students view route has add-parent POST handler with family-confirm logic", () => {
    const content = fs.readFileSync("./routes/views/students.views.js", "utf8");
    expect(content).toContain("/add-parent");
    expect(content).toContain("addParentToStudentService");
    expect(content).toContain("family-confirm-addparent");
  });

  it("student edit view has inline parent edit form", () => {
    const content = fs.readFileSync("./views/students/edit.ejs", "utf8");
    expect(content).toContain("update-parent");
    expect(content).toContain("parentName");
    expect(content).toContain("parentEmail");
    expect(content).toContain("parentPhone");
    expect(content).toContain("relationship");
  });

  it("student edit view has add-parent form for unlinked students", () => {
    const content = fs.readFileSync("./views/students/edit.ejs", "utf8");
    expect(content).toContain("add-parent");
    expect(content).toContain("Add parent");
    expect(content).toContain("addParentName");
    expect(content).toContain("addParentPhone");
  });

  it("family-confirm-addparent view posts to student add-parent endpoint", () => {
    const content = fs.readFileSync("./views/students/family-confirm-addparent.ejs", "utf8");
    expect(content).toContain("/add-parent");
    expect(content).toContain("familyAction");
    expect(content).toContain("matchedParent");
  });

  it("Parent model has email uniqueness constraint", () => {
    const content = fs.readFileSync("./models/Parents/parents.model.js", "utf8");
    // Check that email field has unique: true
    expect(content).toMatch(/email[\s\S]*?unique:\s*true/);
  });

  it("edit view does NOT re-trigger family matching on phone change (hint text)", () => {
    const content = fs.readFileSync("./views/students/edit.ejs", "utf8");
    expect(content).toMatch(/does not re-trigger family matching/i);
  });
});
