/**
 * Tests for the admin marks audit and the per-student marking timeline that
 * the mark-entry roster now exposes.
 *
 * getMarksAuditService must derive, per test:
 *   • score statistics — count, avg / min / max (raw marks AND percentages)
 *   • the marking timeline — first upload (earliest createdAt), last update
 *     (latest updatedAt) and WHICH teacher made that last change
 *   • unmarked tests still appear (markedCount 0) so the admin sees gaps
 *   • search filters by test / subject / class name; the teacher filter
 *     keeps only the tests a given marker (by id or name) entered
 *
 * getTestRosterService must attach markedAt / firstMarkedAt / markedByName to
 * already-marked students (and nulls to unmarked ones) so the UI can show
 * when a teacher uploaded the marks.
 *
 * Models are mocked at the data layer; the real service maths executes.
 */

const mockTestFind = jest.fn();
const mockTestFindById = jest.fn();
const mockResultFind = jest.fn();
const mockStudentFind = jest.fn();
const mockAssignmentFind = jest.fn();
const mockTeacherFind = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  find: (...a) => mockTestFind(...a),
  findById: (...a) => {
    const p = Promise.resolve(mockTestFindById(...a));
    p.populate = jest.fn().mockReturnThis();
    return p;
  },
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockResultFind(...a),
}));
jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
}));
jest.mock("../models/Academic/assignment.model", () => ({
  find: (...a) => mockAssignmentFind(...a),
}));
jest.mock("../models/Staff/teachers.model", () => ({
  find: (...a) => mockTeacherFind(...a),
}));

const { getMarksAuditService, getTestRosterService } = require("../services/academic/test.service");

// ── Helpers ──────────────────────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Chainable query stub: Test.find().populate().populate().sort().lean() */
function chainQuery(docs) {
  const q = {
    populate: jest.fn(() => q),
    sort: jest.fn(() => q),
    select: jest.fn(() => q),
    lean: jest.fn(() => Promise.resolve(docs)),
  };
  return q;
}

const TEACHER_A = { _id: "t-a", name: "Ms. Ayesha" };
const TEACHER_B = { _id: "t-b", name: "Mr. Bilal" };

const TEST_ONE = {
  _id: "test-1",
  name: "Weekly Test 1",
  subject: { _id: "s1", name: "Math" },
  classLevels: [{ _id: "c1", name: "Grade 5 — Blue" }],
  date: new Date("2026-09-10T00:00:00Z"),
  totalMarks: 50,
  passMarks: 20,
};

const TEST_TWO = {
  _id: "test-2",
  name: "Weekly Test 2",
  subject: { _id: "s1", name: "Math" },
  classLevels: [{ _id: "c1", name: "Grade 5 — Blue" }],
  date: new Date("2026-09-17T00:00:00Z"),
  totalMarks: 40,
  passMarks: 16,
};

// test-1 results: 10/50 (20%), 40/50 (80%), 30/50 (60%) → avg 53.33%, min 20, max 80.
// Timeline: first upload 09-11 by Ayesha; last update 09-20 by Bilal.
const RESULTS_ONE = [
  { test: "test-1", student: "b1", score: 10, markedBy: TEACHER_A, createdAt: new Date("2026-09-11T08:00:00Z"), updatedAt: new Date("2026-09-11T08:00:00Z") },
  { test: "test-1", student: "b2", score: 40, markedBy: TEACHER_A, createdAt: new Date("2026-09-12T09:00:00Z"), updatedAt: new Date("2026-09-12T09:00:00Z") },
  { test: "test-1", student: "b3", score: 30, markedBy: TEACHER_B, createdAt: new Date("2026-09-13T10:00:00Z"), updatedAt: new Date("2026-09-20T14:30:00Z") },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockTestFind.mockReturnValue(chainQuery([TEST_ONE, TEST_TWO]));
  mockResultFind.mockReturnValue(chainQuery(RESULTS_ONE));
  // Marks audit resolves the responsible teacher(s) + their WhatsApp numbers
  // from assignments + the Teacher collection; default to Ayesha covering the
  // Math / Grade 5-Blue pairing that both sample tests use.
  mockAssignmentFind.mockReturnValue(
    chainQuery([{ teacher: "t-a", subject: "s1", classLevel: "c1" }])
  );
  mockTeacherFind.mockReturnValue(
    chainQuery([
      { _id: "t-a", name: "Ms. Ayesha", whatsappNumber: "+92 300 1111111" },
      { _id: "t-b", name: "Mr. Bilal", whatsappNumber: "" },
    ])
  );
});

// ── Marks audit ──────────────────────────────────────────────────────────────
describe("getMarksAuditService — per-test stats and marking timeline", () => {
  test("computes score stats and percentages from the test's totalMarks", async () => {
    const res = mockRes();
    await getMarksAuditService({}, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const rows = res.json.mock.calls[0][0].data;
    const row = rows.find((r) => r.testId === "test-1");

    expect(row.markedCount).toBe(3);
    expect(row.avgScore).toBe(26.67);
    expect(row.minScore).toBe(10);
    expect(row.maxScore).toBe(40);
    expect(row.avgPercent).toBe(53.33); // (20 + 80 + 60) / 3
    expect(row.minPercent).toBe(20);
    expect(row.maxPercent).toBe(80);
    expect(row.passCount).toBe(2); // 40 and 30 ≥ passMarks 20
  });

  test("surfaces when marks were uploaded and who last changed them", async () => {
    const res = mockRes();
    await getMarksAuditService({}, res);

    const row = res.json.mock.calls[0][0].data.find((r) => r.testId === "test-1");
    expect(new Date(row.firstUploadAt).toISOString()).toBe("2026-09-11T08:00:00.000Z");
    expect(new Date(row.lastUploadAt).toISOString()).toBe("2026-09-13T10:00:00.000Z");
    expect(new Date(row.lastUpdateAt).toISOString()).toBe("2026-09-20T14:30:00.000Z");
    expect(row.lastUpdatedBy).toBe("Mr. Bilal");
    expect(row.teachers.sort()).toEqual(["Mr. Bilal", "Ms. Ayesha"]);
  });

  test("unmarked tests still appear with a zero count and empty timeline", async () => {
    const res = mockRes();
    await getMarksAuditService({}, res);

    const row = res.json.mock.calls[0][0].data.find((r) => r.testId === "test-2");
    expect(row.markedCount).toBe(0);
    expect(row.avgScore).toBeNull();
    expect(row.avgPercent).toBeNull();
    expect(row.firstUploadAt).toBeNull();
    expect(row.lastUpdateAt).toBeNull();
    expect(row.lastUpdatedBy).toBeNull();
  });

  test("search filters rows by test name, subject or class", async () => {
    const res = mockRes();
    await getMarksAuditService({ search: "weekly test 1" }, res);

    const rows = res.json.mock.calls[0][0].data;
    expect(rows.map((r) => r.testId)).toEqual(["test-1"]);
  });

  test("teacher filter keeps only the tests that teacher marked", async () => {
    // By marker id (what the page's dropdown submits).
    const byId = mockRes();
    await getMarksAuditService({ teacher: "t-b" }, byId);
    expect(byId.json.mock.calls[0][0].data.map((r) => r.testId)).toEqual(["test-1"]);

    // By teacher name, case-insensitive.
    const byName = mockRes();
    await getMarksAuditService({ teacher: "ms. ayesha" }, byName);
    expect(byName.json.mock.calls[0][0].data.map((r) => r.testId)).toEqual(["test-1"]);

    // An unknown teacher matches nothing — even the unmarked test is excluded.
    const none = mockRes();
    await getMarksAuditService({ teacher: "t-none" }, none);
    expect(none.json.mock.calls[0][0].data).toEqual([]);
  });

  test("rows expose marker id→name pairs for the dropdown", async () => {
    const res = mockRes();
    await getMarksAuditService({}, res);

    const row = res.json.mock.calls[0][0].data.find((r) => r.testId === "test-1");
    expect(row.markers.map((m) => m.id).sort()).toEqual(["t-a", "t-b"]);
    expect(row.markers.find((m) => m.id === "t-a").name).toBe("Ms. Ayesha");

    const empty = res.json.mock.calls[0][0].data.find((r) => r.testId === "test-2");
    expect(empty.markers).toEqual([]);
  });

  test("counts 0-mark students as absent, excludes them from stats, flags overdue, resolves reminder teachers", async () => {
    // Add a zero-score result → that student is reported absent AND dropped
    // from the avg / min / max stats (they must not drag the average down).
    mockResultFind.mockReturnValue(
      chainQuery([...RESULTS_ONE, { test: "test-1", student: "b4", score: 0, markedBy: TEACHER_A, createdAt: new Date("2026-09-14T08:00:00Z"), updatedAt: new Date("2026-09-14T08:00:00Z") }])
    );

    const res = mockRes();
    await getMarksAuditService({}, res);
    const rows = res.json.mock.calls[0][0].data;
    const row = rows.find((r) => r.testId === "test-1");

    // One student scored exactly 0 → counted as absent (and not passed).
    expect(row.absentCount).toBe(1);
    expect(row.passCount).toBe(2);
    // markedCount still counts every entered row, including the absence.
    expect(row.markedCount).toBe(4);
    // Stats are over the three real marks (10, 40, 30) — unchanged by the 0.
    expect(row.avgScore).toBe(26.67);
    expect(row.minScore).toBe(10);
    expect(row.maxScore).toBe(40);

    // Both sample tests are dated well over 3 days ago (relative to now) → overdue.
    expect(row.overdue).toBe(true);

    // Reminder target is the assigned teacher with a saved WhatsApp number.
    expect(row.reminderTeachers).toEqual([{ name: "Ms. Ayesha", whatsapp: "+92 300 1111111" }]);
  });

  test("a recent test is not flagged overdue", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // ~1h ago
    mockTestFind.mockReturnValue(chainQuery([{ ...TEST_TWO, date: future }]));

    const res = mockRes();
    await getMarksAuditService({}, res);
    const row = res.json.mock.calls[0][0].data.find((r) => r.testId === "test-2");
    expect(row.overdue).toBe(false);
  });
});

// ── Roster marking timeline ──────────────────────────────────────────────────
describe("getTestRosterService — exposes per-student marks upload info", () => {
  const STUDENTS = [
    { _id: "b1", name: "Ali", studentId: "S1", rollNumber: 1, classLevel: "c1" },
    { _id: "b9", name: "Zara", studentId: "S9", rollNumber: 9, classLevel: "c1" },
  ];

  beforeEach(() => {
    mockTestFindById.mockResolvedValue({ ...TEST_ONE, classLevels: ["c1"] });
    mockAssignmentFind.mockImplementation(() => ({
      select: jest.fn().mockResolvedValue([{ classLevel: "c1" }]),
    }));
    // Chainable + awaitable stub: find().select() and find().select().populate()
    // both resolve to the student docs (the roster service populates `parent`).
    mockStudentFind.mockImplementation(() => {
      const chain = {
        select: () => chain,
        populate: () => chain,
        then: (resolve, reject) => Promise.resolve(STUDENTS).then(resolve, reject),
      };
      return chain;
    });
    mockResultFind.mockImplementation(() => ({
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([RESULTS_ONE[0]]),
    }));
  });

  test("marked student carries markedAt / firstMarkedAt / marker name", async () => {
    const res = mockRes();
    await getTestRosterService("test-1", "teacher-1", res);

    const roster = res.json.mock.calls[0][0].data.roster;
    const marked = roster.find((r) => r.student === "b1");
    expect(marked.score).toBe(10);
    expect(new Date(marked.markedAt).toISOString()).toBe("2026-09-11T08:00:00.000Z");
    expect(new Date(marked.firstMarkedAt).toISOString()).toBe("2026-09-11T08:00:00.000Z");
    expect(marked.markedByName).toBe("Ms. Ayesha");
  });

  test("unmarked student has null score and null timeline", async () => {
    const res = mockRes();
    await getTestRosterService("test-1", "teacher-1", res);

    const roster = res.json.mock.calls[0][0].data.roster;
    const unmarked = roster.find((r) => r.student === "b9");
    expect(unmarked.score).toBeNull();
    expect(unmarked.markedAt).toBeNull();
    expect(unmarked.markedByName).toBeNull();
  });
});
