/**
 * Admission date (Student.dateAdmitted) on the registration and edit forms.
 *
 * The field already existed on the model (default: Date.now) and is read by the
 * day-granular test-roster cutoff in utils/testRosterEligibility.js, but was
 * never settable — this is a form-field addition, not a schema change.
 *
 * These tests pin:
 *   • the validation contract (real calendar date, plausible window, blank
 *     means "not provided" rather than "clear it");
 *   • registration stores the picked day and refuses a garbage date BEFORE the
 *     family match can create a Parent document;
 *   • edit stores the picked day, leaves the recorded date untouched when blank;
 *   • the student self-update path still cannot touch it;
 *   • a plain teacher is rejected by the admin/manager guard, so the field can't
 *     be written through the API either;
 *   • the stored shape keeps the existing roster-eligibility rule intact.
 */

const Admin = require("../models/Staff/admin.model");
const Teacher = require("../models/Staff/teachers.model");
const Parent = require("../models/Parents/parents.model");
const ClassLevel = require("../models/Academic/class.model");

jest.mock("../models/Staff/admin.model");
jest.mock("../models/Staff/teachers.model");
jest.mock("../models/Parents/parents.model", () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  updateMany: jest.fn(),
}));
jest.mock("../models/Academic/class.model", () => ({
  findById: jest.fn(),
  find: jest.fn(),
}));
jest.mock("../models/Students/students.model", () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock("../handlers/passHash.handler", () => ({
  hashPassword: jest.fn(async (pw) => `hashed_${pw}`),
  isPassMatched: jest.fn(async (plain, hash) => hash === `hashed_${plain}`),
}));

const Student = require("../models/Students/students.model");
const isAdminOrManager = require("../middlewares/isAdminOrManager");
const { requireAdminOrManager } = require("../middlewares/authView");
const {
  adminRegisterStudentService,
  adminUpdateStudentService,
  studentUpdateProfileService,
} = require("../services/students/students.service");
const {
  normalizeAdmissionDate,
  admissionDateInputValue,
} = require("../utils/admissionDate");
const {
  admissionCutoffForTest,
  isAdmittedByTest,
} = require("../utils/testRosterEligibility");

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

function mockRes() {
  const res = {};
  res.locals = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  res.render = jest.fn().mockReturnValue(res);
  return res;
}

const validRegisterPayload = (extra = {}) => ({
  name: "Ali Raza",
  email: "ali@school.test",
  password: "secret123",
  classLevel: "class-1",
  rollNumber: "42",
  fatherName: "Raza Sahib",
  address: "Lahore",
  whatsappNumber: "03001234567",
  gender: "Male",
  ...extra,
});

/** Admin passes the service's own admin/manager check. */
const asAdmin = () => {
  Admin.findById.mockResolvedValue({ _id: "admin-1", role: "admin" });
  Teacher.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  asAdmin();
  Student.findOne.mockResolvedValue(null); // email + roll free
  ClassLevel.findById.mockResolvedValue({ _id: "class-1", name: "Grade 5" });
  Student.create.mockImplementation(async (doc) => ({
    ...doc,
    _id: "stu-1",
    toObject: () => ({ ...doc, _id: "stu-1" }),
  }));
  Admin.findByIdAndUpdate.mockResolvedValue({});
});

// ═════════════════════════════════════════════════════════════════════════════
// Validation contract
// ═════════════════════════════════════════════════════════════════════════════

describe("normalizeAdmissionDate", () => {
  it("accepts a plain YYYY-MM-DD date at UTC midnight of that day", () => {
    const out = normalizeAdmissionDate("2026-03-05");
    expect(out.ok).toBe(true);
    expect(out.date.toISOString()).toBe("2026-03-05T00:00:00.000Z");
  });

  it("treats blank / missing as 'not provided' (caller keeps the default)", () => {
    for (const v of [undefined, null, "", "   "]) {
      const out = normalizeAdmissionDate(v);
      expect(out.ok).toBe(true);
      expect(out.date).toBeUndefined();
    }
  });

  it("rejects a value that is not a YYYY-MM-DD calendar date", () => {
    for (const v of ["15/03/2026", "2026-3-5", "March 2026", "abc", "2026", "99"]) {
      const out = normalizeAdmissionDate(v);
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/YYYY-MM-DD/);
    }
  });

  it("rejects an impossible day instead of rolling it over", () => {
    const out = normalizeAdmissionDate("2026-02-30");
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not a real calendar date/);
  });

  it("rejects an implausibly old date", () => {
    const out = normalizeAdmissionDate("1899-12-31");
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/earlier than 1900/);
  });

  it("accepts a near-future date (a pupil may be admitted in advance)", () => {
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 30);
    const out = normalizeAdmissionDate(soon.toISOString().slice(0, 10));
    expect(out.ok).toBe(true);
  });

  it("rejects an absurdly far-future date", () => {
    const out = normalizeAdmissionDate("2099-01-01");
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/in the future/);
  });
});

describe("admissionDateInputValue", () => {
  it("renders a stored date back as the picker's YYYY-MM-DD value", () => {
    expect(admissionDateInputValue(new Date("2026-03-05T00:00:00.000Z"))).toBe("2026-03-05");
  });

  it("returns an empty value when nothing usable is recorded", () => {
    expect(admissionDateInputValue(null)).toBe("");
    expect(admissionDateInputValue(undefined)).toBe("");
    expect(admissionDateInputValue("not-a-date")).toBe("");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Registration form
// ═════════════════════════════════════════════════════════════════════════════

describe("adminRegisterStudentService — admission date", () => {
  it("stores the admission date picked on the form", async () => {
    const res = captureRes();
    await adminRegisterStudentService(
      validRegisterPayload({ dateAdmitted: "2025-04-18" }),
      "admin-1",
      res.res
    );

    expect(res.statusCode).toBe(200);
    const created = Student.create.mock.calls[0][0];
    expect(created.dateAdmitted.toISOString()).toBe("2025-04-18T00:00:00.000Z");
  });

  it("leaves the model default (today) in place when the field is blank", async () => {
    const res = captureRes();
    await adminRegisterStudentService(
      validRegisterPayload({ dateAdmitted: "" }),
      "admin-1",
      res.res
    );

    expect(res.statusCode).toBe(200);
    // undefined → Mongoose applies `default: Date.now`; no raw string is stored.
    expect(Student.create.mock.calls[0][0].dateAdmitted).toBeUndefined();
  });

  it("rejects a bogus admission date with 400 and creates nothing", async () => {
    const res = captureRes();
    await adminRegisterStudentService(
      validRegisterPayload({ dateAdmitted: "31-04-2026" }),
      "admin-1",
      res.res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.status).toBe("failed");
    expect(Student.create).not.toHaveBeenCalled();
  });

  it("validates the date BEFORE the family match can create a parent", async () => {
    const res = captureRes();
    await adminRegisterStudentService(
      validRegisterPayload({
        dateAdmitted: "2026-02-30",
        parentName: "Raza Sahib",
        parentPhone: "03001234567",
        familyAction: "new",
      }),
      "admin-1",
      res.res
    );

    expect(res.statusCode).toBe(400);
    expect(Parent.create).not.toHaveBeenCalled();
    expect(Student.create).not.toHaveBeenCalled();
  });

  it("keeps the admin/manager guard on registration", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ isAttendanceManager: false }) }),
    });

    const res = captureRes();
    await adminRegisterStudentService(
      validRegisterPayload({ dateAdmitted: "2025-04-18" }),
      "teacher-1",
      res.res
    );

    expect(res.statusCode).toBe(403);
    expect(Student.create).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Edit form
// ═════════════════════════════════════════════════════════════════════════════

describe("adminUpdateStudentService — admission date", () => {
  const existing = () => ({
    _id: "stu-1",
    name: "Ali Raza",
    email: "ali@school.test",
    rollNumber: "42",
    classLevel: "class-1",
    dateAdmitted: new Date("2025-04-18T00:00:00.000Z"),
  });

  const updatedChain = () =>
    Student.findByIdAndUpdate.mockReturnValue({
      select: jest.fn().mockResolvedValue(existing()),
    });

  it("updates the admission date when an admin edits it", async () => {
    Student.findById.mockResolvedValue(existing());
    updatedChain();

    const res = captureRes();
    await adminUpdateStudentService({ dateAdmitted: "2026-01-07" }, "stu-1", res.res);

    expect(res.statusCode).toBe(200);
    const set = Student.findByIdAndUpdate.mock.calls[0][1].$set;
    expect(set.dateAdmitted.toISOString()).toBe("2026-01-07T00:00:00.000Z");
  });

  it("leaves the recorded date untouched when the field is submitted blank", async () => {
    Student.findById.mockResolvedValue(existing());
    updatedChain();

    const res = captureRes();
    await adminUpdateStudentService(
      { name: "Ali Raza", dateAdmitted: "" },
      "stu-1",
      res.res
    );

    expect(res.statusCode).toBe(200);
    const set = Student.findByIdAndUpdate.mock.calls[0][1].$set;
    expect("dateAdmitted" in set).toBe(false);
    expect(set.name).toBe("Ali Raza");
  });

  it("rejects an invalid admission date with 400 and writes nothing", async () => {
    Student.findById.mockResolvedValue(existing());

    const res = captureRes();
    await adminUpdateStudentService({ dateAdmitted: "07/2026" }, "stu-1", res.res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/YYYY-MM-DD/);
    expect(Student.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects an implausible admission date before updating other fields", async () => {
    Student.findById.mockResolvedValue(existing());

    const res = captureRes();
    await adminUpdateStudentService(
      { name: "Changed", dateAdmitted: "2026-02-30" },
      "stu-1",
      res.res
    );

    expect(res.statusCode).toBe(400);
    expect(Student.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Access control — a teacher cannot write the field, even directly via the API
// ═════════════════════════════════════════════════════════════════════════════

describe("Access control — admission date write paths", () => {
  it("API PATCH /:studentId/update/admin rejects a plain teacher (403, no next())", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({
      _id: "teacher-1",
      role: "teacher",
      isAttendanceManager: false,
      isSuspended: false,
    });

    const req = {
      userAuth: { id: "teacher-1" },
      params: { studentId: "stu-1" },
      // The payload a teacher would try to smuggle through:
      body: { dateAdmitted: "2020-01-01" },
    };
    const res = mockRes();
    const next = jest.fn();

    await isAdminOrManager(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("API PATCH allows an admin and a manager through to the service", async () => {
    Admin.findById.mockResolvedValue({ _id: "admin-1", role: "admin" });
    Teacher.findById.mockResolvedValue(null);
    const nextAdmin = jest.fn();
    await isAdminOrManager({ userAuth: { id: "admin-1" } }, mockRes(), nextAdmin);
    expect(nextAdmin).toHaveBeenCalled();

    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({
      _id: "mgr-1",
      role: "teacher",
      isAttendanceManager: true,
      isSuspended: false,
    });
    const nextManager = jest.fn();
    await isAdminOrManager({ userAuth: { id: "mgr-1" } }, mockRes(), nextManager);
    expect(nextManager).toHaveBeenCalled();
  });

  it("view routes for register/edit reject a plain teacher", async () => {
    const guard = requireAdminOrManager();
    const res = mockRes();
    const next = jest.fn();

    await guard({ user: { _id: "teacher-1", role: "teacher", isManager: false, isSuspended: false } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("a student editing their own profile cannot set the admission date", async () => {
    Student.findByIdAndUpdate.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: "stu-1" }),
    });

    const res = captureRes();
    await studentUpdateProfileService(
      { email: "new@school.test", dateAdmitted: "2020-01-01" },
      "stu-1",
      res.res
    );

    expect(res.statusCode).toBe(200);
    const update = Student.findByIdAndUpdate.mock.calls[0][1];
    expect(update.email).toBe("new@school.test");
    expect("dateAdmitted" in update).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Existing consumers of dateAdmitted stay correct with a form-set value
// ═════════════════════════════════════════════════════════════════════════════

describe("Test-roster eligibility is unaffected by the form value", () => {
  // Tests are stored as UTC midnight of their calendar day (the tests form does
  // `new Date("YYYY-MM-DD")`), which is exactly the shape the admission-date
  // field now writes — so the day-granular cutoff keeps its whole-day margin.
  const TEST_DAY = "2026-09-15";
  const cutoff = () => admissionCutoffForTest(new Date(TEST_DAY));

  it("a pupil admitted on the test's own day stays eligible", () => {
    const stored = normalizeAdmissionDate(TEST_DAY).date;
    expect(isAdmittedByTest(stored, cutoff())).toBe(true);
  });

  it("a pupil admitted the day after the test is excluded", () => {
    const stored = normalizeAdmissionDate("2026-09-16").date;
    expect(isAdmittedByTest(stored, cutoff())).toBe(false);
  });

  it("a pupil admitted earlier is eligible", () => {
    const stored = normalizeAdmissionDate("2025-04-18").date;
    expect(isAdmittedByTest(stored, cutoff())).toBe(true);
  });

  it("the stored date reads back as the same calendar day it was set from", () => {
    expect(admissionDateInputValue(normalizeAdmissionDate(TEST_DAY).date)).toBe(TEST_DAY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Route & view wiring
// ═════════════════════════════════════════════════════════════════════════════

describe("Route & view wiring", () => {
  const fs = require("fs");

  it("registration POST whitelists dateAdmitted", () => {
    const content = fs.readFileSync("./routes/views/students.views.js", "utf8");
    expect(content).toMatch(/const fields = \[[\s\S]*?"dateAdmitted",\s*\];/);
  });

  it("edit route passes the recorded admission date to the form", () => {
    const content = fs.readFileSync("./routes/views/students.views.js", "utf8");
    expect(content).toContain("admissionDateInputValue(student.dateAdmitted)");
  });

  it("registration form renders a prefilled Admission date input", () => {
    const content = fs.readFileSync("./views/students/list.ejs", "utf8");
    expect(content).toMatch(/name="dateAdmitted"/);
    expect(content).toMatch(/type="date"/);
    expect(content).toContain("Admission date");
  });

  it("edit form renders an Admission date input", () => {
    const content = fs.readFileSync("./views/students/edit.ejs", "utf8");
    expect(content).toMatch(/name="dateAdmitted"/);
    expect(content).toContain("Admission date");
  });

  it("the model still owns the dateAdmitted field (no schema change needed)", () => {
    const content = fs.readFileSync("./models/Students/students.model.js", "utf8");
    expect(content).toMatch(/dateAdmitted:\s*{[\s\S]*?type:\s*Date/);
  });
});
