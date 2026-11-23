/**
 * Manager access to Mark Attendance — regression lock.
 *
 * Reported regression: the "Mark attendance" nav item had vanished from the
 * manager sidebar. Diagnosis: the route guards were never touched — the link
 * was collateral damage. It lived in the teacher sidebar section, and a
 * manager's DB-derived identity is role "teacher" + isAttendanceManager, so
 * managers rendered that section and lost the link when commit 7f33f4c
 * ("Teacher dashboard: split panels, move My Classes to page + sidebar")
 * removed it from the teacher view. Nothing re-added it to the management
 * section, so the action became unreachable from the nav even though the
 * routes behind it still answered for a manager.
 *
 * The contract these tests lock, in both directions:
 *   • a manager marks attendance for ANY class/section, admin-level — the
 *     marking path carries no subject-assignment scoping anywhere (guard,
 *     controller or service);
 *   • a manager still gets no Fee / Income / Expense access, view or API.
 *
 * Templates are rendered for real (EJS) rather than grep'd, so a future edit
 * that drops the link again fails here instead of shipping.
 */

const fs = require("fs");
const path = require("path");
const ejs = require("ejs");
const mongoose = require("mongoose");

// Data layer stubbed with plain fns (no automock) so the real middlewares and
// the real marking service execute.
jest.mock("../models/Staff/admin.model", () => ({ findById: jest.fn() }));
jest.mock("../models/Staff/teachers.model", () => ({ findById: jest.fn() }));
jest.mock("../models/Students/students.model", () => ({ find: jest.fn() }));
jest.mock("../models/Academic/attendance.model", () => ({
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  distinct: jest.fn(),
}));

const { requireRole, requireAdminOrManager } = require("../middlewares/authView");
const isAdmin = require("../middlewares/isAdmin");
const isAdminOrManager = require("../middlewares/isAdminOrManager");
const isAttendanceManager = require("../middlewares/isAttendanceManager");

const Admin = require("../models/Staff/admin.model");
const Teacher = require("../models/Staff/teachers.model");
const Student = require("../models/Students/students.model");
const Attendance = require("../models/Academic/attendance.model");
const Assignment = require("../models/Academic/assignment.model");

const {
  markClassAttendanceService,
  getClassRosterForDateService,
} = require("../services/academic/attendance.service");

const VIEWS = path.join(__dirname, "..", "views");

const ADMIN = { name: "Adm", role: "admin", isManager: false, isSuspended: false };
// A manager is a teacher document with isAttendanceManager — authView derives
// both fields from the DB, so req.user.role stays "teacher" and isManager is true.
const MANAGER = { name: "Mgr", role: "teacher", isManager: true, isSuspended: false };
const TEACHER = { name: "Tch", role: "teacher", isManager: false, isSuspended: false };

function mockRes() {
  const res = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.render = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}
const nextFn = () => jest.fn();

// ── 1. The nav item itself ──────────────────────────────────────────────────

function renderSidebar(user) {
  return ejs.render(fs.readFileSync(path.join(VIEWS, "partials", "sidebar.ejs"), "utf8"),
    { user, page: "dashboard", schoolName: "Test School" },
    { filename: path.join(VIEWS, "partials", "sidebar.ejs") });
}

// The href of the sidebar <a> whose text is exactly `label`. Sidebar links
// carry their label as plain text, so an exact match (not a substring) keeps
// "Fees" from matching "Fee heads" and the label lookup unambiguous.
function sidebarLink(html, label) {
  const wanted = label.toLowerCase();
  for (const m of html.matchAll(/<a href="([^"]+)"[^>]*>\s*([^<]*)<\/a>/g)) {
    if (m[2].trim().toLowerCase() === wanted) return m[1];
  }
  return null;
}

describe('Sidebar — "Mark attendance" nav item', () => {
  it("RENDERS the link for a manager, pointing at /attendance", () => {
    expect(sidebarLink(renderSidebar(MANAGER), "Mark attendance")).toBe("/attendance");
  });

  it("does NOT render it for a plain teacher (marking is not a teacher action)", () => {
    expect(sidebarLink(renderSidebar(TEACHER), "Mark attendance")).toBeNull();
  });

  it("does NOT render it for a plain admin (POST /attendance is manager-gated)", () => {
    // Locked deliberately: isAttendanceManager 403s an admin document, so a
    // link that led to a 403 page would be a worse regression than no link.
    expect(sidebarLink(renderSidebar(ADMIN), "Mark attendance")).toBeNull();
  });

  it("keeps every other management nav item for a manager", () => {
    const html = renderSidebar(MANAGER);
    expect(sidebarLink(html, "Attendance rollup")).toBe("/attendance/rollup");
    expect(sidebarLink(html, "Manage tests")).toBe("/tests/manage");
    expect(sidebarLink(html, "All students")).toBe("/students");
  });
});

describe('Dashboard — "Mark attendance" tile', () => {
  const base = {
    page: "dashboard",
    schoolName: "Test School",
    stats: { fees: { pending: 0 }, attendance: { percent: null }, marks: {}, teacher: null, student: null },
    charts: {},
    atRisk: [],
    pendingMarking: [],
    teacherTests: [],
    alertThresholds: { ATTENDANCE: 80, SCORE: 50 },
    // app.locals in the running app (app/app.js); passed explicitly here.
    safeJson: require("../utils/safeJson").safeJson,
    safeJsonAttr: require("../utils/safeJson").safeJsonAttr,
  };

  const render = (user) =>
    ejs.renderFile(path.join(VIEWS, "dashboard.ejs"), { ...base, user });

  it("renders a tile linking to /attendance for a manager", async () => {
    const html = await render(MANAGER);
    const tiles = [...html.matchAll(/<a href="(\/attendance)"[^>]*>(?:(?!<\/a>)[\s\S])*?Mark attendance/gi)];
    expect(tiles.length).toBeGreaterThan(0);
  });

  it("renders no marking entry point for a plain teacher", async () => {
    const html = await render(TEACHER);
    expect(/>Mark attendance/gi.test(html)).toBe(false);
  });
});

// ── 2. The guards behind the link — manager passes, for ANY class ───────────

describe("View-route guard — /attendance pages", () => {
  // The three view routes (pick-class, mark form, mark POST) all use
  // requireRole("teacher"); a manager's DB-derived role IS "teacher", which is
  // why the guard was never the problem.
  it("allows a manager through requireRole('teacher')", async () => {
    const next = nextFn();
    await requireRole("teacher")({ user: MANAGER }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("still refuses a plain admin on the same guard", async () => {
    const next = nextFn();
    const res = mockRes();
    await requireRole("teacher")({ user: ADMIN }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("keeps a suspended manager out", async () => {
    const next = nextFn();
    const res = mockRes();
    await requireRole("teacher")({ user: { ...MANAGER, isSuspended: true } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("wires requireRole('teacher') on all three marking routes, with no assignment-scoped guard", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "routes", "views", "attendance.views.js"), "utf8"
    );
    for (const route of [
      /router\.get\("\/attendance",\s*requireRole\("teacher"\)/,
      /router\.get\("\/attendance\/mark\/:classLevelId",\s*requireRole\("teacher"\)/,
      /router\.post\("\/attendance\/mark\/:classLevelId",\s*requireRole\("teacher"\)/,
    ]) {
      expect(src).toMatch(route);
    }
    // The teacher-only assignment gate must never be bolted onto marking.
    expect(src).not.toMatch(/isAssignedTo/);
  });
});

describe("API guard — isAttendanceManager (POST /attendance + roster)", () => {
  beforeEach(() => jest.clearAllMocks());

  const apiReq = (classLevelId) => ({
    userAuth: { id: "manager-id" },
    params: { classLevelId },
    body: {},
  });

  it("allows a manager, for any class, without consulting assignments", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({ _id: "manager-id", isAttendanceManager: true });
    const next = nextFn();

    await isAttendanceManager(apiReq(new mongoose.Types.ObjectId()), mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(Teacher.findById).toHaveBeenCalledWith("manager-id");
    expect(Assignment.findOne).not.toHaveBeenCalled();
    expect(Assignment.find).not.toHaveBeenCalled();
    expect(Assignment.distinct).not.toHaveBeenCalled();
  });

  it("refuses a plain teacher with 403", async () => {
    Teacher.findById.mockResolvedValue({ _id: "t", isAttendanceManager: false });
    const next = nextFn();
    const res = mockRes();

    await isAttendanceManager(apiReq(new mongoose.Types.ObjectId()), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("refuses a suspended manager", async () => {
    Teacher.findById.mockResolvedValue({
      _id: "t", isAttendanceManager: true, isSuspended: true,
    });
    const next = nextFn();
    const res = mockRes();

    await isAttendanceManager(apiReq(new mongoose.Types.ObjectId()), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("attendance.router.js gates marking on isAttendanceManager, never the teacher-scoped guard", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "routes", "v1", "academic", "attendance.router.js"), "utf8"
    );
    expect(src).toMatch(/\.route\("\/attendance"\)\.post\(isLoggedIn,\s*isAttendanceManager,/);
    expect(src).toMatch(/\.route\("\/attendance\/roster\/:classLevelId"\)\.get\(isLoggedIn,\s*isAttendanceManager,/);
    // The read-only teacher endpoints are separate routes; marking must not move onto them.
    expect(src).toMatch(/\.route\("\/attendance\/teacher-view"\)\.get\(isLoggedIn,\s*isTeacher,/);
  });
});

describe("Marking service — unrestricted across classes", () => {
  const CLASS_A = new mongoose.Types.ObjectId();
  const CLASS_B = new mongoose.Types.ObjectId();
  const STUDENT = { _id: new mongoose.Types.ObjectId(), name: "Ali", rollNumber: "1" };

  beforeEach(() => {
    jest.clearAllMocks();
    Student.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([STUDENT]),
      populate: jest.fn().mockResolvedValue([STUDENT]),
    });
    Attendance.findOneAndUpdate.mockResolvedValue({ _id: "att" });
    Attendance.find.mockResolvedValue([]);
  });

  it("marks a class the manager has no assignment for", async () => {
    const res = mockRes();
    await markClassAttendanceService(
      CLASS_B, "2026-11-20", [{ student: String(STUDENT._id), status: "present" }], "manager-id", res
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(Attendance.findOneAndUpdate).toHaveBeenCalled();
    expect(Assignment.findOne).not.toHaveBeenCalled();
    expect(Assignment.distinct).not.toHaveBeenCalled();
  });

  it("returns the roster for any class requested", async () => {
    const res = mockRes();
    await getClassRosterForDateService(CLASS_A, "2026-11-20", res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toHaveLength(1);
    expect(Assignment.find).not.toHaveBeenCalled();
    expect(Assignment.distinct).not.toHaveBeenCalled();
  });

  it("still refuses an inactive/foreign student (fail-closed guard intact)", async () => {
    const res = mockRes();
    await markClassAttendanceService(
      CLASS_A, "2026-11-20", [{ student: String(new mongoose.Types.ObjectId()), status: "present" }],
      "manager-id", res
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Attendance.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

// ── 3. Fee / Income / Expense stay closed to the manager ────────────────────

describe("Manager remains blocked from Fee / Income / Expense", () => {
  beforeEach(() => jest.clearAllMocks());

  it("requireRole('admin') 403s a manager on the fee/income/expense views", async () => {
    for (const user of [MANAGER, TEACHER]) {
      const next = nextFn();
      const res = mockRes();
      await requireRole("admin")({ user }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  it("requireRole('admin') still allows a full admin", async () => {
    const next = nextFn();
    await requireRole("admin")({ user: ADMIN }, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("isAdmin (API) 403s a manager", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({ _id: "t", isAttendanceManager: true });
    const next = nextFn();
    const res = mockRes();

    await isAdmin({ userAuth: { id: "t" } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("isAdminOrManager (used by attendance rollups) allows a manager", async () => {
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue({ _id: "t", isAttendanceManager: true });
    const next = nextFn();

    await isAdminOrManager({ userAuth: { id: "t" } }, mockRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it("the finance view routes are all requireRole('admin'), and the view guard for rollups is admin-or-manager", () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, "..", "routes", "views", p), "utf8");
    for (const file of ["fees.views.js", "income.views.js", "expenses.views.js"]) {
      const src = read(file);
      const routes = src.match(/router\.(get|post)\("[^"]+",\s*requireRole\([^)]*\)/g) || [];
      expect(routes.length).toBeGreaterThan(0);
      for (const r of routes) expect(r).toMatch(/requireRole\("admin"\)/);
      expect(src).not.toMatch(/requireAdminOrManager/);
    }
    // Attendance reporting stays open to managers — the other half of the same rule.
    expect(read("attendanceRollup.views.js")).toMatch(
      /router\.get\("\/attendance\/rollup",\s*requireAdminOrManager\(\)/
    );
    expect(typeof requireAdminOrManager).toBe("function");
  });

  it("fee/income/expense API routers use isAdmin, not isAdminOrManager", () => {
    const read = (p) => fs.readFileSync(
      path.join(__dirname, "..", "routes", "v1", p), "utf8");
    for (const file of ["fees/fees.router.js", "income/income.router.js", "expenses/expenses.router.js"]) {
      const src = read(file);
      expect(src).toMatch(/\bisAdmin\b/);
      expect(src).not.toMatch(/isAdminOrManager/);
    }
  });

  it("the manager sidebar exposes no fee/income/expense nav entries", () => {
    const html = renderSidebar(MANAGER);
    for (const label of ["Fees", "Income", "Income heads", "Expenses", "Daily report"]) {
      expect(sidebarLink(html, label)).toBeNull();
    }
    // ...while an admin still sees them.
    expect(sidebarLink(renderSidebar(ADMIN), "Fees")).toBe("/fees");
  });
});
