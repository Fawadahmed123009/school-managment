/**
 * "Manage tests" → Edit — each test must be editable by admin and manager.
 *
 * Covers:
 *   • updateTestService applies the same rules as creation (category chain,
 *     subject ↔ class scope, score scale);
 *   • submitted scores protect the test's identity: subject/classes can't be
 *     re-pointed and totalMarks can't be lowered under an existing score;
 *   • grouping (session/phase/week), name, date and scale stay editable even
 *     with results present;
 *   • the API and view routes are gated on admin OR manager.
 *
 * All models are mocked at the data layer so the real service logic runs
 * without a database.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockTestFindById = jest.fn();
const mockResultCountDocuments = jest.fn();
const mockResultFind = jest.fn();
const mockTestSessionFindById = jest.fn();
const mockSubjectFindById = jest.fn();
const mockClassLevelFindById = jest.fn();
const mockWeekFindById = jest.fn();
const mockAdminFindById = jest.fn();
const mockTeacherFindById = jest.fn();

const chainPromise = (value) => {
  const promise = Promise.resolve(value);
  promise.populate = jest.fn().mockReturnValue(promise);
  promise.select = jest.fn().mockReturnValue(promise);
  return promise;
};

jest.mock("../models/Academic/test.model", () => ({
  findById: (...a) => chainPromise(mockTestFindById(...a)),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  countDocuments: (...a) => mockResultCountDocuments(...a),
  find: (...a) => chainPromise(mockResultFind(...a)),
}));
jest.mock("../models/Academic/testSession.model", () => ({
  findById: (...a) => mockTestSessionFindById(...a),
}));
jest.mock("../models/Academic/subject.model", () => ({
  findById: (...a) => mockSubjectFindById(...a),
}));
jest.mock("../models/Academic/class.model", () => ({
  findById: (...a) => mockClassLevelFindById(...a),
}));
jest.mock("../models/Academic/week.model", () => ({
  findById: (...a) => mockWeekFindById(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  find: () => chainPromise([]),
  findOne: () => chainPromise(null),
  distinct: () => chainPromise([]),
}));
jest.mock("../models/Students/students.model", () => ({
  find: () => chainPromise([]),
}));
// Identity lookups for the isAdminOrManager gate.
jest.mock("../models/Staff/admin.model", () => ({
  findById: (...a) => mockAdminFindById(...a),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  findById: (...a) => mockTeacherFindById(...a),
}));

// ── Subjects under test ──────────────────────────────────────────────────────
const { updateTestService, getTestByIdService, createTestService } = require("../services/academic/test.service");
const isAdminOrManager = require("../middlewares/isAdminOrManager");
const { requireAdminOrManager } = require("../middlewares/authView");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const TEST_ID = "test-1";
const SESSION_ID = "session-1";
const PHASE_ID = "phase-1";
const WEEK_ID = "week-1";
const SUBJECT_ID = "subject-1";
const CLASS_ID = "class-1";
const CLASS_ID_2 = "class-2";

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** A stored test, standalone by default, with a spy-able save(). */
function makeTestDoc(overrides = {}) {
  const doc = {
    _id: TEST_ID,
    name: "Quiz 1",
    subject: SUBJECT_ID,
    classLevels: [CLASS_ID],
    date: new Date("2026-01-10"),
    totalMarks: 50,
    passMarks: 20,
    session: null,
    phase: null,
    week: null,
    ...overrides,
  };
  doc.save = jest.fn().mockResolvedValue(doc);
  return doc;
}

/** The create-form body, standalone unless a test overrides it. */
function body(overrides = {}) {
  return {
    name: "Quiz 1 (revised)",
    subject: SUBJECT_ID,
    classLevels: [CLASS_ID],
    date: "2026-01-12",
    totalMarks: 50,
    passMarks: 20,
    session: null,
    phase: null,
    week: null,
    ...overrides,
  };
}

const MOCK_SESSION = {
  _id: SESSION_ID,
  name: "Term 1",
  phases: [{ _id: PHASE_ID, name: "Phase 1", order: 1 }],
};

let res;

beforeEach(() => {
  jest.clearAllMocks();
  res = mockRes();

  mockTestFindById.mockReturnValue(makeTestDoc());
  mockResultCountDocuments.mockResolvedValue(0);
  mockResultFind.mockResolvedValue([]);
  mockTestSessionFindById.mockResolvedValue(MOCK_SESSION);
  mockSubjectFindById.mockResolvedValue({
    _id: SUBJECT_ID,
    name: "Math",
    appliesTo: [{ classLevel: CLASS_ID }, { classLevel: CLASS_ID_2 }],
  });
  mockClassLevelFindById.mockImplementation((id) => ({
    _id: id,
    name: id === CLASS_ID ? "Grade 9 A" : "Grade 9 B",
    gradeLevel: "9",
  }));
  mockWeekFindById.mockResolvedValue({ _id: WEEK_ID, session: SESSION_ID, phase: PHASE_ID });
});

const statusOf = () => res.status.mock.calls[res.status.mock.calls.length - 1][0];
const bodyOf = () => res.json.mock.calls[res.json.mock.calls.length - 1][0];

// ═══════════════════════════════════════════════════════════════════════════════
// 1. The edit path writes the new values
// ═══════════════════════════════════════════════════════════════════════════════

describe("updateTestService — applies edits", () => {
  test("saves the edited name, date and scale on a standalone test", async () => {
    const doc = makeTestDoc({ session: SESSION_ID, phase: PHASE_ID, week: WEEK_ID });
    mockTestFindById.mockReturnValue(doc);

    await updateTestService(TEST_ID, body(), res);

    expect(statusOf()).toBe(200);
    expect(doc.name).toBe("Quiz 1 (revised)");
    expect(doc.date).toBe("2026-01-12");
    expect(doc.totalMarks).toBe(50);
    expect(doc.passMarks).toBe(20);
    // No session chosen → the whole category chain is cleared
    expect(doc.session).toBeNull();
    expect(doc.phase).toBeNull();
    expect(doc.week).toBeNull();
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  test("can re-group a test into a session phase week while keeping its scores", async () => {
    const doc = makeTestDoc();
    mockTestFindById.mockReturnValue(doc);
    mockResultCountDocuments.mockResolvedValue(12); // already marked

    await updateTestService(
      TEST_ID,
      body({ session: SESSION_ID, phase: PHASE_ID, week: WEEK_ID }),
      res
    );

    expect(statusOf()).toBe(200);
    expect(doc.session).toBe(SESSION_ID);
    expect(doc.phase).toBe(PHASE_ID);
    expect(doc.week).toBe(WEEK_ID);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  test("trims the name before storing it", async () => {
    const doc = makeTestDoc();
    mockTestFindById.mockReturnValue(doc);

    await updateTestService(TEST_ID, body({ name: "  Mid Term  " }), res);

    expect(doc.name).toBe("Mid Term");
  });

  test("404s for a nonexistent test", async () => {
    mockTestFindById.mockReturnValue(null);

    await updateTestService("missing", body(), res);

    expect(statusOf()).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Creation rules apply unchanged on the edit path
// ═══════════════════════════════════════════════════════════════════════════════

describe("updateTestService — same rules as creation", () => {
  test("rejects a test with no classes and does not save", async () => {
    const doc = makeTestDoc();
    mockTestFindById.mockReturnValue(doc);

    await updateTestService(TEST_ID, body({ classLevels: [] }), res);

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/at least one class/i);
    expect(doc.save).not.toHaveBeenCalled();
  });

  test("rejects a blank name", async () => {
    await updateTestService(TEST_ID, body({ name: "   " }), res);

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/name is required/i);
  });

  test("rejects a total below 1", async () => {
    await updateTestService(TEST_ID, body({ totalMarks: 0 }), res);

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/total marks/i);
  });

  test("rejects pass marks above total marks", async () => {
    await updateTestService(TEST_ID, body({ totalMarks: 50, passMarks: 60 }), res);

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/cannot exceed/i);
  });

  test("rejects a session that does not exist", async () => {
    mockTestSessionFindById.mockResolvedValue(null);

    await updateTestService(TEST_ID, body({ session: "ghost-session" }), res);

    expect(statusOf()).toBe(404);
    expect(bodyOf().message).toMatch(/session not found/i);
  });

  test("requires a week once a session phase is chosen", async () => {
    await updateTestService(
      TEST_ID,
      body({ session: SESSION_ID, phase: PHASE_ID, week: null }),
      res
    );

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/week is required/i);
  });

  test("rejects a week from a different phase", async () => {
    mockWeekFindById.mockResolvedValue({ _id: WEEK_ID, session: SESSION_ID, phase: "other-phase" });

    await updateTestService(
      TEST_ID,
      body({ session: SESSION_ID, phase: PHASE_ID, week: WEEK_ID }),
      res
    );

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/does not belong/i);
  });

  test("rejects a subject that is not taught in one of the classes", async () => {
    mockSubjectFindById.mockResolvedValue({
      _id: SUBJECT_ID,
      name: "Math",
      appliesTo: [{ classLevel: CLASS_ID }],
    });

    await updateTestService(TEST_ID, body({ classLevels: [CLASS_ID, CLASS_ID_2] }), res);

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/is not taught in/i);
  });

  test("shares the validators with creation: a bad placement is rejected identically", async () => {
    mockWeekFindById.mockResolvedValue(null);

    const editRes = mockRes();
    const createRes = mockRes();
    const data = { ...body(), week: WEEK_ID, session: SESSION_ID, phase: PHASE_ID };

    await updateTestService(TEST_ID, data, editRes);
    await createTestService(data, "admin-1", createRes);

    expect(editRes.status.mock.calls[0]).toEqual(createRes.status.mock.calls[0]);
    expect(editRes.json.mock.calls[0][0].message).toBe(createRes.json.mock.calls[0][0].message);
  });

  test("leaves a legacy placement untouched when it is not being changed", async () => {
    // Stored before the week rule: a session + phase with no week. Renaming it
    // must not force the admin to re-categorise.
    const doc = makeTestDoc({ session: SESSION_ID, phase: PHASE_ID, week: null });
    mockTestFindById.mockReturnValue(doc);

    await updateTestService(
      TEST_ID,
      body({ name: "Renamed only", session: SESSION_ID, phase: PHASE_ID, week: null }),
      res
    );

    expect(statusOf()).toBe(200);
    expect(mockTestSessionFindById).not.toHaveBeenCalled();
    expect(doc.name).toBe("Renamed only");
  });

  test("re-validates the placement as soon as it changes", async () => {
    const doc = makeTestDoc({ session: SESSION_ID, phase: PHASE_ID, week: null });
    mockTestFindById.mockReturnValue(doc);

    // Moving it to a phase the session does not have is rejected.
    await updateTestService(
      TEST_ID,
      body({ session: SESSION_ID, phase: "other-phase", week: null }),
      res
    );

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/phase not found/i);
    expect(doc.save).not.toHaveBeenCalled();

    // Giving it a proper week is accepted.
    const okRes = mockRes();
    await updateTestService(
      TEST_ID,
      body({ session: SESSION_ID, phase: PHASE_ID, week: WEEK_ID }),
      okRes
    );

    expect(okRes.status).toHaveBeenCalledWith(200);
    expect(doc.week).toBe(WEEK_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Submitted scores protect the test's scope and ceiling
// ═══════════════════════════════════════════════════════════════════════════════

describe("updateTestService — protects results already submitted", () => {
  test("refuses to switch subject once scores exist", async () => {
    const doc = makeTestDoc();
    mockTestFindById.mockReturnValue(doc);
    mockResultCountDocuments.mockResolvedValue(7);
    mockSubjectFindById.mockResolvedValue({
      _id: "subject-2",
      name: "Urdu",
      appliesTo: [{ classLevel: CLASS_ID }],
    });

    await updateTestService(TEST_ID, body({ subject: "subject-2" }), res);

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/cannot change the subject or classes/i);
    expect(doc.subject).toBe(SUBJECT_ID);
    expect(doc.save).not.toHaveBeenCalled();
  });

  test("refuses to change the class list once scores exist", async () => {
    const doc = makeTestDoc();
    mockTestFindById.mockReturnValue(doc);
    mockResultCountDocuments.mockResolvedValue(3);

    await updateTestService(TEST_ID, body({ classLevels: [CLASS_ID_2] }), res);

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/cannot change the subject or classes/i);
    expect(doc.save).not.toHaveBeenCalled();
  });

  test("treats a re-ordered class list as unchanged scope", async () => {
    const doc = makeTestDoc({ classLevels: [CLASS_ID, CLASS_ID_2] });
    mockTestFindById.mockReturnValue(doc);
    mockResultCountDocuments.mockResolvedValue(4);

    await updateTestService(TEST_ID, body({ classLevels: [CLASS_ID_2, CLASS_ID] }), res);

    expect(statusOf()).toBe(200);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  test("refuses to lower total marks below an entered score", async () => {
    mockTestFindById.mockReturnValue(makeTestDoc({ totalMarks: 100 }));
    mockResultCountDocuments.mockResolvedValue(2);
    mockResultFind.mockResolvedValue([{ score: 30, student: { name: "Ali" } }]);

    await updateTestService(TEST_ID, body({ totalMarks: 20, passMarks: 10 }), res);

    expect(statusOf()).toBe(400);
    expect(bodyOf().message).toMatch(/exceed it/i);
  });

  test("allows shrinking the scale while every entered score still fits", async () => {
    const doc = makeTestDoc({ totalMarks: 100 });
    mockTestFindById.mockReturnValue(doc);
    mockResultCountDocuments.mockResolvedValue(2);
    mockResultFind.mockResolvedValue([]);

    await updateTestService(TEST_ID, body({ totalMarks: 50, passMarks: 20 }), res);

    expect(statusOf()).toBe(200);
    expect(doc.totalMarks).toBe(50);
  });

  test("an unmarked test may change subject and classes freely", async () => {
    const doc = makeTestDoc();
    mockTestFindById.mockReturnValue(doc);
    mockSubjectFindById.mockResolvedValue({
      _id: "subject-2",
      name: "Urdu",
      appliesTo: [{ classLevel: CLASS_ID_2 }],
    });

    await updateTestService(TEST_ID, body({ subject: "subject-2", classLevels: [CLASS_ID_2] }), res);

    expect(statusOf()).toBe(200);
    expect(doc.subject).toBe("subject-2");
    expect(doc.classLevels).toEqual([CLASS_ID_2]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Read route feeding the edit form
// ═══════════════════════════════════════════════════════════════════════════════

describe("getTestByIdService", () => {
  test("returns the populated test for the edit form", async () => {
    const doc = makeTestDoc();
    mockTestFindById.mockReturnValue(doc);

    await getTestByIdService(TEST_ID, res);

    expect(statusOf()).toBe(200);
    expect(bodyOf().data).toBe(doc);
  });

  test("404s for an unknown id", async () => {
    mockTestFindById.mockReturnValue(null);

    await getTestByIdService("missing", res);

    expect(statusOf()).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Who may edit — admin and manager only
// ═══════════════════════════════════════════════════════════════════════════════

describe("edit routes are gated on admin OR manager", () => {
  const apiReq = (id) => ({ userAuth: { id }, params: {}, body: {} });
  const viewReq = (user) => ({ user });

  const runApi = async (user) => {
    const next = jest.fn();
    const r = mockRes();
    await isAdminOrManager(apiReq(user), r, next);
    return { next, r };
  };

  beforeEach(() => {
    mockAdminFindById.mockResolvedValue(null);
    mockTeacherFindById.mockResolvedValue(null);
  });

  test("admin is allowed", async () => {
    mockAdminFindById.mockResolvedValue({ _id: "a", role: "admin" });
    const { next, r } = await runApi("admin-1");
    expect(next).toHaveBeenCalled();
    expect(r.status).not.toHaveBeenCalled();
  });

  test("manager (teacher with isAttendanceManager) is allowed", async () => {
    mockTeacherFindById.mockResolvedValue({ _id: "t", role: "teacher", isAttendanceManager: true, isSuspended: false });
    const { next, r } = await runApi("teacher-1");
    expect(next).toHaveBeenCalled();
    expect(r.status).not.toHaveBeenCalled();
  });

  test("plain teacher is rejected with 403", async () => {
    mockTeacherFindById.mockResolvedValue({ _id: "t", role: "teacher", isAttendanceManager: false });
    const { next, r } = await runApi("teacher-2");
    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(403);
  });

  test("view routes use requireAdminOrManager on both GET and POST", () => {
    const gate = requireAdminOrManager();
    const viewRes = () => {
      const r = { locals: {} };
      r.status = jest.fn().mockReturnValue(r);
      r.render = jest.fn().mockReturnValue(r);
      r.redirect = jest.fn().mockReturnValue(r);
      return r;
    };

    const adminRes = viewRes();
    const adminNext = jest.fn();
    gate(viewReq({ role: "admin" }), adminRes, adminNext);
    expect(adminNext).toHaveBeenCalled();

    const managerRes = viewRes();
    const managerNext = jest.fn();
    gate(viewReq({ role: "teacher", isManager: true }), managerRes, managerNext);
    expect(managerNext).toHaveBeenCalled();

    const teacherRes = viewRes();
    const teacherNext = jest.fn();
    gate(viewReq({ role: "teacher", isManager: false }), teacherRes, teacherNext);
    expect(teacherNext).not.toHaveBeenCalled();
    expect(teacherRes.status).toHaveBeenCalledWith(403);
  });

  test("the router wires GET and PATCH /tests/:testId to isAdminOrManager", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "routes", "v1", "academic", "test.router.js"),
      "utf8"
    );

    const block = source.match(/\.route\("\/tests\/:testId"\)[\s\S]*?deleteTestController\);/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/\.get\(isLoggedIn,\s*isAdminOrManager,\s*getTestByIdController\)/);
    expect(block[0]).toMatch(/\.patch\(isLoggedIn,\s*isAdminOrManager,\s*updateTestController\)/);
    expect(block[0]).toMatch(/\.delete\(isLoggedIn,\s*isAdminOrManager,\s*deleteTestController\)/);
  });

  test("the ledger offers an Edit link for every test row", () => {
    const fs = require("fs");
    const path = require("path");
    const view = fs.readFileSync(
      path.join(__dirname, "..", "views", "tests", "manage.ejs"),
      "utf8"
    );
    expect(view).toMatch(/href="\/tests\/<%=\s*t\._id\s*%>\/edit"/);
  });
});
