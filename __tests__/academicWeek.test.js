/**
 * Academic Week feature — verification tests (redesigned).
 *
 * New design: Week belongs to a Phase within a TestSession (not AcademicYear).
 *
 * 1. Creating a week requires session + phase (not academicYear).
 * 2. Standalone test creation (no session) works without a week.
 * 3. Session-based test creation (with session+phase) requires a week
 *    that belongs to the correct session+phase.
 * 4. Week CRUD works within session context.
 * 5. Deleting a week unlinks tests (sets week: null) rather than deleting them.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockTestCreate = jest.fn();
const mockTestFind = jest.fn();
const mockTestFindOne = jest.fn();
const mockTestFindOneAndUpdate = jest.fn();
const mockTestUpdateMany = jest.fn();
const mockTestDeleteOne = jest.fn();

const mockWeekCreate = jest.fn();
const mockWeekFind = jest.fn();
const mockWeekFindById = jest.fn();
const mockWeekFindByIdAndUpdate = jest.fn();
const mockWeekFindByIdAndDelete = jest.fn();

const mockTestSessionFindById = jest.fn();

const mockSubjectFindById = jest.fn();
const mockClassLevelFindById = jest.fn();

const mockTestResultDeleteMany = jest.fn();

// Chainable mock helpers
const chainable = (returnVal) => {
  const obj = {};
  obj.populate = jest.fn().mockReturnValue(obj);
  obj.sort = jest.fn().mockReturnValue(obj);
  obj.lean = jest.fn().mockResolvedValue(returnVal);
  obj.then = (resolve) => resolve(returnVal);
  return obj;
};

jest.mock("../models/Academic/test.model", () => {
  const Model = function () {};
  Model.create = (...a) => mockTestCreate(...a);
  Model.find = (...a) => {
    const r = mockTestFind(...a);
    return r;
  };
  Model.findOne = (...a) => mockTestFindOne(...a);
  Model.findOneAndUpdate = (...a) => mockTestFindOneAndUpdate(...a);
  Model.updateMany = (...a) => mockTestUpdateMany(...a);
  Model.deleteOne = (...a) => mockTestDeleteOne(...a);
  Model.aggregate = jest.fn().mockResolvedValue([]);
  return Model;
});

jest.mock("../models/Academic/testResult.model", () => ({
  deleteMany: (...a) => mockTestResultDeleteMany(...a),
  find: jest.fn().mockReturnValue(chainable([])),
}));

jest.mock("../models/Academic/testSession.model", () => ({
  findById: (...a) => mockTestSessionFindById(...a),
  find: jest.fn().mockReturnValue(chainable([])),
}));

jest.mock("../models/Academic/week.model", () => {
  const Model = function () {};
  Model.create = (...a) => mockWeekCreate(...a);
  Model.find = (...a) => {
    const r = mockWeekFind(...a);
    return r;
  };
  Model.findById = (...a) => mockWeekFindById(...a);
  Model.findByIdAndUpdate = (...a) => mockWeekFindByIdAndUpdate(...a);
  Model.findByIdAndDelete = (...a) => mockWeekFindByIdAndDelete(...a);
  return Model;
});

jest.mock("../models/Academic/subject.model", () => ({
  findById: (...a) => mockSubjectFindById(...a),
  find: jest.fn().mockReturnValue(chainable([])),
}));

jest.mock("../models/Academic/class.model", () => ({
  findById: (...a) => mockClassLevelFindById(...a),
  find: jest.fn().mockReturnValue(chainable([])),
  aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock("../models/Students/students.model", () => ({
  find: jest.fn().mockReturnValue(chainable([])),
  aggregate: jest.fn().mockResolvedValue([]),
}));

jest.mock("../models/Academic/assignment.model", () => ({}));

const { createTestService, getAllTestsService } = require("../services/academic/test.service");
const {
  createWeekService,
  getWeeksForSessionService,
  deleteWeekService,
} = require("../services/academic/week.service");

const ADMIN_ID = "admin-abc";
const SESSION_ID = "session-001";
const PHASE_ID = "phase-001";
const WEEK_ID = "week-001";
const SUBJECT_ID = "subject-001";
const CLASS_ID = "class-001";

const MOCK_SESSION = {
  _id: SESSION_ID,
  name: "Term 1",
  phases: [{ _id: PHASE_ID, name: "Phase 1", order: 1 }],
};

let fakeRes;

beforeEach(() => {
  jest.clearAllMocks();
  fakeRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  fakeRes.status.mockImplementation((code) => {
    fakeRes._statusCode = code;
    return fakeRes;
  });
  fakeRes.json.mockImplementation((body) => {
    fakeRes._body = body;
    return fakeRes;
  });

  // Default mocks
  mockTestCreate.mockImplementation(async (doc) => ({
    _id: "test-" + Math.random().toString(36).slice(2, 8),
    ...doc,
  }));

  mockTestSessionFindById.mockResolvedValue(MOCK_SESSION);
  mockSubjectFindById.mockResolvedValue({
    _id: SUBJECT_ID,
    name: "Math",
    appliesTo: [{ classLevel: CLASS_ID }],
  });
  mockClassLevelFindById.mockResolvedValue({
    _id: CLASS_ID,
    name: "Grade 9",
    gradeLevel: "9",
  });
});

// ─── 1. Week creation requires session + phase ──────────────────────────────
describe("Week creation requires session + phase", () => {
  test("createWeekService creates a week with session and phase", async () => {
    mockWeekCreate.mockImplementation(async (doc) => ({
      _id: "week-new",
      ...doc,
    }));

    const data = {
      name: "Week 3",
      session: SESSION_ID,
      phase: PHASE_ID,
      startDate: "2025-10-06",
      endDate: "2025-10-10",
    };

    await createWeekService(data, ADMIN_ID, fakeRes);

    expect(mockWeekCreate).toHaveBeenCalledTimes(1);
    const created = mockWeekCreate.mock.calls[0][0];
    expect(created.name).toBe("Week 3");
    expect(created.session).toBe(SESSION_ID);
    expect(created.phase).toBe(PHASE_ID);
    expect(created.createdBy).toBe(ADMIN_ID);
    expect(fakeRes._statusCode).toBe(201);
  });

  test("createWeekService rejects when session is missing", async () => {
    const data = {
      name: "Week 3",
      phase: PHASE_ID,
      startDate: "2025-10-06",
      endDate: "2025-10-10",
    };

    await createWeekService(data, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(fakeRes._body.message).toMatch(/session.*phase.*required/i);
    expect(mockWeekCreate).not.toHaveBeenCalled();
  });

  test("createWeekService rejects when phase is missing", async () => {
    const data = {
      name: "Week 3",
      session: SESSION_ID,
      startDate: "2025-10-06",
      endDate: "2025-10-10",
    };

    await createWeekService(data, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(fakeRes._body.message).toMatch(/session.*phase.*required/i);
    expect(mockWeekCreate).not.toHaveBeenCalled();
  });

  test("createWeekService rejects when phase doesn't exist in session", async () => {
    const data = {
      name: "Week 3",
      session: SESSION_ID,
      phase: "nonexistent-phase",
      startDate: "2025-10-06",
      endDate: "2025-10-10",
    };

    await createWeekService(data, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(fakeRes._body.message).toMatch(/phase not found/i);
    expect(mockWeekCreate).not.toHaveBeenCalled();
  });

  test("createWeekService rejects when end date is before start date", async () => {
    const data = {
      name: "Bad Week",
      session: SESSION_ID,
      phase: PHASE_ID,
      startDate: "2025-10-10",
      endDate: "2025-10-06",
    };

    await createWeekService(data, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(fakeRes._body.message).toMatch(/end date/i);
    expect(mockWeekCreate).not.toHaveBeenCalled();
  });
});

// ─── 2. Standalone test creation (no session) works without a week ──────────
describe("Standalone test creation works without a week", () => {
  test("allows test creation without week when no session is selected", async () => {
    const data = {
      name: "Quiz 1",
      subject: SUBJECT_ID,
      classLevels: [CLASS_ID],
      date: "2025-10-01",
      totalMarks: 50,
      passMarks: 20,
      // No session, no phase, no week
    };

    await createTestService(data, ADMIN_ID, fakeRes);

    expect(mockTestCreate).toHaveBeenCalledTimes(1);
    const created = mockTestCreate.mock.calls[0][0];
    expect(created.week).toBeUndefined();
    expect(created.session).toBeNull();
    expect(created.phase).toBeNull();
    expect(fakeRes._statusCode).toBe(201);
  });

  test("allows test creation with empty string session (standalone)", async () => {
    const data = {
      name: "Quiz 1",
      subject: SUBJECT_ID,
      classLevels: [CLASS_ID],
      date: "2025-10-01",
      totalMarks: 50,
      passMarks: 20,
      session: "",
      week: "",
    };

    await createTestService(data, ADMIN_ID, fakeRes);

    expect(mockTestCreate).toHaveBeenCalledTimes(1);
    expect(fakeRes._statusCode).toBe(201);
  });
});

// ─── 3. Session-based test requires a week from the correct phase ───────────
describe("Session-based test requires a week from the correct phase", () => {
  test("blocks test creation when session+phase set but no week", async () => {
    const data = {
      name: "Quiz 1",
      subject: SUBJECT_ID,
      classLevels: [CLASS_ID],
      date: "2025-10-01",
      totalMarks: 50,
      passMarks: 20,
      session: SESSION_ID,
      phase: PHASE_ID,
      // week is intentionally omitted
    };

    await createTestService(data, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(fakeRes._body.message).toMatch(/week is required/i);
    expect(mockTestCreate).not.toHaveBeenCalled();
  });

  test("allows test creation when week belongs to the correct session+phase", async () => {
    mockWeekFindById.mockResolvedValue({
      _id: WEEK_ID,
      session: SESSION_ID,
      phase: PHASE_ID,
    });

    const data = {
      name: "Quiz 1",
      subject: SUBJECT_ID,
      classLevels: [CLASS_ID],
      date: "2025-10-01",
      totalMarks: 50,
      passMarks: 20,
      session: SESSION_ID,
      phase: PHASE_ID,
      week: WEEK_ID,
    };

    await createTestService(data, ADMIN_ID, fakeRes);

    expect(mockTestCreate).toHaveBeenCalledTimes(1);
    expect(fakeRes._statusCode).toBe(201);
  });

  test("blocks test creation when week belongs to a different phase", async () => {
    mockWeekFindById.mockResolvedValue({
      _id: WEEK_ID,
      session: SESSION_ID,
      phase: "different-phase",
    });

    const data = {
      name: "Quiz 1",
      subject: SUBJECT_ID,
      classLevels: [CLASS_ID],
      date: "2025-10-01",
      totalMarks: 50,
      passMarks: 20,
      session: SESSION_ID,
      phase: PHASE_ID,
      week: WEEK_ID,
    };

    await createTestService(data, ADMIN_ID, fakeRes);

    expect(fakeRes._statusCode).toBe(400);
    expect(fakeRes._body.message).toMatch(/does not belong/i);
    expect(mockTestCreate).not.toHaveBeenCalled();
  });
});

// ─── 4. Existing week-less tests remain valid ───────────────────────────────
describe("Existing week-less tests (week: null) remain valid", () => {
  test("Test model schema allows week to be null/undefined (not required at schema level)", () => {
    const fs = require("fs");
    const path = require("path");
    const modelSource = fs.readFileSync(
      path.join(__dirname, "../models/Academic/test.model.js"),
      "utf8"
    );
    const weekBlockMatch = modelSource.match(/week:\s*\{[^}]*\}/s);
    expect(weekBlockMatch).toBeTruthy();
    expect(weekBlockMatch[0]).not.toMatch(/required:\s*true/);
    expect(weekBlockMatch[0]).toMatch(/default:\s*null/);
  });

  test("getAllTestsService returns tests regardless of week value", async () => {
    const mockTests = [
      { _id: "t1", name: "Old Test", week: null, subject: { _id: "s1", name: "Math" }, classLevels: [{ _id: "c1", name: "G9" }] },
      { _id: "t2", name: "New Test", week: { _id: "w1", name: "Week 3" }, subject: { _id: "s1", name: "Math" }, classLevels: [{ _id: "c1", name: "G9" }] },
    ];

    const chain = chainable(mockTests);
    mockTestFind.mockReturnValue(chain);

    const result = await getAllTestsService(fakeRes);

    expect(fakeRes._statusCode).toBe(200);
    expect(fakeRes._body.data).toHaveLength(2);
    expect(fakeRes._body.data[0].week).toBeNull();
    expect(fakeRes._body.data[1].week).toBeTruthy();
  });
});

// ─── 5. Deleting a week unlinks tests ───────────────────────────────────────
describe("Deleting a week unlinks tests", () => {
  test("deleteWeekService unlinks tests and deletes the week", async () => {
    const chain = chainable({ _id: WEEK_ID, name: "Week 3" });
    mockWeekFindById.mockReturnValue(chain);
    mockWeekFindByIdAndDelete.mockResolvedValue({ _id: WEEK_ID });
    mockTestUpdateMany.mockResolvedValue({ modifiedCount: 2 });

    await deleteWeekService(WEEK_ID, fakeRes);

    expect(mockTestUpdateMany).toHaveBeenCalledWith(
      { week: WEEK_ID },
      { $set: { week: null } }
    );
    expect(mockWeekFindByIdAndDelete).toHaveBeenCalledWith(WEEK_ID);
    expect(fakeRes._statusCode).toBe(200);
  });
});
