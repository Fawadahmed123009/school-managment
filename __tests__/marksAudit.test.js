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
 *     keeps only the tests a given marker entered, matching their id or any
 *     part of their name (the audit page's typeahead sends a typed fragment)
 *   • the session / phase / week cascade filters rows by category id (with
 *     "none" matching tests missing that level); rows carry category labels
 *     plus the phase's `order`, the week's start date and the subject id, which
 *     the page's five-level cascade (session → grade → phase → week → subject)
 *     uses to list phases and weeks chronologically and to filter by subject
 *   • the grade / class cascade keys off each test's ClassLevels: a test is
 *     kept when ANY of its classes matches, and rows expose gradeLevels +
 *     classLevels so the page can build the dependent dropdowns
 *   • marking status is derived from the class rosters: `marked` only when
 *     every active student of the test's classes has a score row; marked
 *     tests drop the overdue/critical flags and sort to the bottom
 *   • results are paginated ({rows, pagination}) — page/limit slice the
 *     sorted rows and report the unpaginated total; limit=all disables it
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
const mockSessionFind = jest.fn();

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
// Marks audit resolves bare phase ids through the sessions' phases subdocs.
jest.mock("../models/Academic/testSession.model", () => ({
  find: (...a) => mockSessionFind(...a),
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

// Test dates are relative to "now" on purpose: the urgency tiers (overdue past
// 3 days, critical past 5) are measured against the clock, so absolute fixture
// dates would silently change tier every day the suite kept running — and the
// ordering assertions below rely on test-1 / test-2 being critical while
// test-3 is merely overdue.
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const TEST_ONE = {
  _id: "test-1",
  name: "Weekly Test 1",
  subject: { _id: "s1", name: "Math" },
  classLevels: [{ _id: "c1", name: "Grade 5 — Blue", gradeLevel: "5" }],
  date: daysAgo(18),
  totalMarks: 50,
  passMarks: 20,
  session: { _id: "sess-1", name: "Fall 2026" },
  phase: "ph-1",
  week: { _id: "w-1", name: "Week 3", startDate: new Date("2026-09-08T00:00:00Z") },
};

const TEST_TWO = {
  _id: "test-2",
  name: "Weekly Test 2",
  subject: { _id: "s1", name: "Math" },
  classLevels: [{ _id: "c1", name: "Grade 5 — Blue", gradeLevel: "5" }],
  date: daysAgo(11),
  totalMarks: 40,
  passMarks: 16,
};

// A test in an empty class — it can never be "marked", so its flags stay live
// no matter how the other rosters fill up. Recent enough to be overdue only,
// which is what puts it between the two critical tests and the marked one.
const TEST_THREE = {
  _id: "test-3",
  name: "Weekly Test 3",
  subject: { _id: "s1", name: "Math" },
  classLevels: [{ _id: "c3", name: "Grade 6 — Red", gradeLevel: "6" }],
  date: daysAgo(4),
  totalMarks: 30,
  passMarks: 12,
};

// Session fixture whose phases subdoc resolves TEST_ONE's bare phase id.
const SESSIONS = [{ _id: "sess-1", phases: [{ _id: "ph-1", name: "Midterm", order: 1 }] }];

// Roster sizes the audit measures marking completion against: c1 holds exactly
// the pupils in RESULTS_ONE (so test-1 is fully marked), c2 has one student
// pending, c3 is empty.
const STUDENT_ROWS = [
  { classLevel: "c1" },
  { classLevel: "c1" },
  { classLevel: "c1" },
  { classLevel: "c2" },
];

// test-1 results: 10/50 (20%), 40/50 (80%), 30/50 (60%) → avg 53.33%, min 20, max 80.
// Timeline: first upload 09-11 by Ayesha; last update 09-20 by Bilal.
const RESULTS_ONE = [
  { test: "test-1", student: "b1", score: 10, markedBy: TEACHER_A, createdAt: new Date("2026-09-11T08:00:00Z"), updatedAt: new Date("2026-09-11T08:00:00Z") },
  { test: "test-1", student: "b2", score: 40, markedBy: TEACHER_A, createdAt: new Date("2026-09-12T09:00:00Z"), updatedAt: new Date("2026-09-12T09:00:00Z") },
  { test: "test-1", student: "b3", score: 30, markedBy: TEACHER_B, createdAt: new Date("2026-09-13T10:00:00Z"), updatedAt: new Date("2026-09-20T14:30:00Z") },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockTestFind.mockReturnValue(chainQuery([TEST_ONE, TEST_TWO, TEST_THREE]));
  mockResultFind.mockReturnValue(chainQuery(RESULTS_ONE));
  mockSessionFind.mockReturnValue(chainQuery(SESSIONS));
  // Marks audit compares each test's distinct marked pupils against the
  // ACTIVE roster of its classes (inactive / graduated / withdrawn excluded).
  mockStudentFind.mockReturnValue(chainQuery(STUDENT_ROWS));
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
/** Rows returned by getMarksAuditService (response data is a paged envelope). */
const auditRows = (res) => res.json.mock.calls[0][0].data.rows;

describe("getMarksAuditService — per-test stats and marking timeline", () => {
  test("computes score stats and percentages from the test's totalMarks", async () => {
    const res = mockRes();
    await getMarksAuditService({}, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const rows = auditRows(res);
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

    const row = auditRows(res).find((r) => r.testId === "test-1");
    expect(new Date(row.firstUploadAt).toISOString()).toBe("2026-09-11T08:00:00.000Z");
    expect(new Date(row.lastUploadAt).toISOString()).toBe("2026-09-13T10:00:00.000Z");
    expect(new Date(row.lastUpdateAt).toISOString()).toBe("2026-09-20T14:30:00.000Z");
    expect(row.lastUpdatedBy).toBe("Mr. Bilal");
    expect(row.teachers.sort()).toEqual(["Mr. Bilal", "Ms. Ayesha"]);
  });

  test("unmarked tests still appear with a zero count and empty timeline", async () => {
    const res = mockRes();
    await getMarksAuditService({}, res);

    const row = auditRows(res).find((r) => r.testId === "test-2");
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

    expect(auditRows(res).map((r) => r.testId)).toEqual(["test-1"]);
  });

  test("teacher filter keeps only the tests that teacher marked", async () => {
    // By marker id (what the page's dropdown submits).
    const byId = mockRes();
    await getMarksAuditService({ teacher: "t-b" }, byId);
    expect(auditRows(byId).map((r) => r.testId)).toEqual(["test-1"]);

    // By teacher name, case-insensitive.
    const byName = mockRes();
    await getMarksAuditService({ teacher: "ms. ayesha" }, byName);
    expect(auditRows(byName).map((r) => r.testId)).toEqual(["test-1"]);

    // Any part of the name is enough — the page's typeahead sends what the
    // admin actually typed ("ayesha" must find "Ms. Ayesha").
    const byFragment = mockRes();
    await getMarksAuditService({ teacher: "AYESHA" }, byFragment);
    expect(auditRows(byFragment).map((r) => r.testId)).toEqual(["test-1"]);

    // An unknown teacher matches nothing — even the unmarked tests are excluded.
    const none = mockRes();
    await getMarksAuditService({ teacher: "t-none" }, none);
    expect(auditRows(none)).toEqual([]);
  });

  test("rows expose marker id→name pairs for the dropdown", async () => {
    const res = mockRes();
    await getMarksAuditService({}, res);

    const row = auditRows(res).find((r) => r.testId === "test-1");
    expect(row.markers.map((m) => m.id).sort()).toEqual(["t-a", "t-b"]);
    expect(row.markers.find((m) => m.id === "t-a").name).toBe("Ms. Ayesha");

    const empty = auditRows(res).find((r) => r.testId === "test-2");
    expect(empty.markers).toEqual([]);
  });

  test("counts 0-mark students as absent, excludes them from stats, flags overdue, resolves reminder teachers", async () => {
    // Add a zero-score result → that student is reported absent AND dropped
    // from the avg / min / max stats (they must not drag the average down).
    // The class roster grows to match, so marking stays complete here.
    mockResultFind.mockReturnValue(
      chainQuery([...RESULTS_ONE, { test: "test-1", student: "b4", score: 0, markedBy: TEACHER_A, createdAt: new Date("2026-09-14T08:00:00Z"), updatedAt: new Date("2026-09-14T08:00:00Z") }])
    );
    // Grow c1 to 6 students so that 4 of them marked still means outstanding.
    mockStudentFind.mockReturnValue(
      chainQuery([...STUDENT_ROWS, { classLevel: "c1" }, { classLevel: "c1" }, { classLevel: "c1" }, { classLevel: "c2" }])
    );

    const res = mockRes();
    await getMarksAuditService({}, res);
    const rows = auditRows(res);
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

    // Dated 18 days back and still outstanding for its classes → flagged
    // overdue, and past the 5-day limit, critical too.
    expect(row.overdue).toBe(true);
    expect(row.critical).toBe(true);
    expect(row.status).toBe("unmarked");

    // Reminder target is the assigned teacher with a saved WhatsApp number.
    expect(row.reminderTeachers).toEqual([{ name: "Ms. Ayesha", whatsapp: "+92 300 1111111" }]);
  });

  test("a recent test is not flagged overdue", async () => {
    const recent = new Date(Date.now() + 60 * 60 * 1000); // ~1h ago
    mockTestFind.mockReturnValue(chainQuery([{ ...TEST_THREE, date: recent }]));

    const res = mockRes();
    await getMarksAuditService({}, res);
    const row = auditRows(res).find((r) => r.testId === "test-3");
    expect(row.overdue).toBe(false);
    expect(row.critical).toBe(false);
  });

  test("rows carry session/phase/week keys and resolved labels", async () => {
    const res = mockRes();
    await getMarksAuditService({}, res);
    const rows = auditRows(res);

    // test-1 is categorised: the bare phase id resolves through the session's
    // phases subdoc into a human-readable label.
    const categorised = rows.find((r) => r.testId === "test-1");
    expect(categorised.session).toBe("sess-1");
    expect(categorised.sessionName).toBe("Fall 2026");
    expect(categorised.phase).toBe("ph-1");
    expect(categorised.phaseName).toBe("Midterm");
    expect(categorised.week).toBe("w-1");
    expect(categorised.weekName).toBe("Week 3");
    // Its calendar start travels too — the page orders its week dropdown by it.
    expect(new Date(categorised.weekStart).toISOString()).toBe("2026-09-08T00:00:00.000Z");

    // test-2 is a standalone test — null keys, empty labels.
    const standalone = rows.find((r) => r.testId === "test-2");
    expect(standalone.session).toBeNull();
    expect(standalone.phase).toBeNull();
    expect(standalone.week).toBeNull();
    expect(standalone.weekStart).toBeNull();
    expect(standalone.sessionName).toBe("");
  });
});

// ── Category cascade + pagination ────────────────────────────────────────────
describe("getMarksAuditService — session/phase/week filters and pagination", () => {
  test("session / phase / week filters narrow rows by category id", async () => {
    const bySession = mockRes();
    await getMarksAuditService({ session: "sess-1" }, bySession);
    expect(auditRows(bySession).map((r) => r.testId)).toEqual(["test-1"]);

    // The phase id is stored bare on the test, so filtering matches it too.
    const byPhase = mockRes();
    await getMarksAuditService({ phase: "ph-1" }, byPhase);
    expect(auditRows(byPhase).map((r) => r.testId)).toEqual(["test-1"]);

    const byWeek = mockRes();
    await getMarksAuditService({ week: "w-1" }, byWeek);
    expect(auditRows(byWeek).map((r) => r.testId)).toEqual(["test-1"]);

    // A category nobody used matches nothing.
    const none = mockRes();
    await getMarksAuditService({ session: "sess-999" }, none);
    expect(auditRows(none)).toEqual([]);
  });

  test('"none" keeps only tests missing that category', async () => {
    const res = mockRes();
    await getMarksAuditService({ session: "none" }, res);
    expect(auditRows(res).map((r) => r.testId).sort()).toEqual(["test-2", "test-3"]);
  });

  test("category filters compose with search and teacher", async () => {
    const res = mockRes();
    await getMarksAuditService({ session: "sess-1", teacher: "t-b" }, res);
    expect(auditRows(res).map((r) => r.testId)).toEqual(["test-1"]);

    // Mr. Bilal never marked the tests outside the session → empty.
    const empty = mockRes();
    await getMarksAuditService({ session: "none", teacher: "t-b" }, empty);
    expect(auditRows(empty)).toEqual([]);
  });

  test("paginates with a total envelope and walks pages", async () => {
    const res = mockRes();
    await getMarksAuditService({ limit: "1" }, res);
    const data = res.json.mock.calls[0][0].data;

    // Urgency first: the overdue test-2 leads, the marked test-1 sorts last.
    expect(data.pagination).toMatchObject({ total: 3, page: 1, limit: 1, pages: 3, hasPrev: false, hasNext: true });
    expect(data.rows.map((r) => r.testId)).toEqual(["test-2"]);

    const last = mockRes();
    await getMarksAuditService({ limit: "1", page: "3" }, last);
    expect(last.json.mock.calls[0][0].data.rows.map((r) => r.testId)).toEqual(["test-1"]);
    expect(last.json.mock.calls[0][0].data.pagination).toMatchObject({ page: 3, hasPrev: true, hasNext: false });

    // A page past the end returns no rows but keeps the total (the view still
    // renders the option lists from the unfiltered fetch).
    const beyond = mockRes();
    await getMarksAuditService({ limit: "1", page: "9" }, beyond);
    expect(beyond.json.mock.calls[0][0].data.rows).toEqual([]);
    expect(beyond.json.mock.calls[0][0].data.pagination.total).toBe(3);
  });

  test("limit=all returns every row unpaged (option-building fetch)", async () => {
    const res = mockRes();
    await getMarksAuditService({ limit: "all" }, res);
    const data = res.json.mock.calls[0][0].data;
    expect(data.rows).toHaveLength(3);
    expect(data.pagination).toMatchObject({ total: 3, pages: 1, hasPrev: false, hasNext: false });
  });

  test("default page size keeps all rows on page 1", async () => {
    const res = mockRes();
    await getMarksAuditService({}, res);
    expect(auditRows(res)).toHaveLength(3);
    expect(res.json.mock.calls[0][0].data.pagination.page).toBe(1);
  });
});

// ── Grade / class cascade ────────────────────────────────────────────────────
describe("getMarksAuditService — grade / class cascade filters", () => {
  // A test spanning two grades (the cascade must keep it under BOTH) and one
  // whose class carries no grade level at all (only "none" may keep it).
  const TEST_MULTI = {
    ...TEST_ONE,
    _id: "test-multi",
    classLevels: [
      { _id: "c1", name: "Grade 5 — Blue", gradeLevel: "5" },
      { _id: "c9", name: "Class Nine", gradeLevel: "9", group: "Pre-Engineering" },
    ],
  };
  const TEST_NOGRADE = {
    ...TEST_TWO,
    _id: "test-nograde",
    classLevels: [{ _id: "cx", name: "Legacy Class" }],
  };

  beforeEach(() => {
    mockTestFind.mockReturnValue(chainQuery([TEST_ONE, TEST_MULTI, TEST_NOGRADE]));
  });

  test("rows expose gradeLevels and classLevels keys", async () => {
    const res = mockRes();
    await getMarksAuditService({ limit: "all" }, res);

    const multi = auditRows(res).find((r) => r.testId === "test-multi");
    expect(multi.gradeLevels).toEqual(["5", "9"]);
    expect(multi.classLevels).toEqual([
      { id: "c1", name: "Grade 5 — Blue", gradeLevel: "5", group: "" },
      { id: "c9", name: "Class Nine", gradeLevel: "9", group: "Pre-Engineering" },
    ]);

    // A class with no grade level still keys the class filter, but is grade-less.
    const noGrade = auditRows(res).find((r) => r.testId === "test-nograde");
    expect(noGrade.gradeLevels).toEqual([]);
    expect(noGrade.classLevels.map((c) => c.id)).toEqual(["cx"]);
  });

  test("grade keeps a test when ANY of its classes sits in that grade", async () => {
    const nine = mockRes();
    await getMarksAuditService({ grade: "9", limit: "all" }, nine);
    expect(auditRows(nine).map((r) => r.testId)).toEqual(["test-multi"]);

    const five = mockRes();
    await getMarksAuditService({ grade: "5", limit: "all" }, five);
    expect(auditRows(five).map((r) => r.testId).sort()).toEqual(["test-1", "test-multi"]);

    // A grade nobody uses matches nothing.
    const none = mockRes();
    await getMarksAuditService({ grade: "12" }, none);
    expect(auditRows(none)).toEqual([]);
  });

  test("classLevel filter matches on the class id", async () => {
    const shared = mockRes();
    await getMarksAuditService({ classLevel: "c1", limit: "all" }, shared);
    expect(auditRows(shared).map((r) => r.testId).sort()).toEqual(["test-1", "test-multi"]);

    const alone = mockRes();
    await getMarksAuditService({ classLevel: "cx", limit: "all" }, alone);
    expect(auditRows(alone).map((r) => r.testId)).toEqual(["test-nograde"]);
  });

  test('"none" keeps grade-less rows and nothing for class-less ones', async () => {
    const noGrade = mockRes();
    await getMarksAuditService({ grade: "none", limit: "all" }, noGrade);
    expect(auditRows(noGrade).map((r) => r.testId)).toEqual(["test-nograde"]);

    // Every row here has at least one class, so "no class" is empty.
    const noClass = mockRes();
    await getMarksAuditService({ classLevel: "none", limit: "all" }, noClass);
    expect(auditRows(noClass)).toEqual([]);
  });

  test("grade / class compose with the session filter", async () => {
    // test-1 and test-multi belong to the session; test-nograde does not.
    const res = mockRes();
    await getMarksAuditService(
      { session: "sess-1", grade: "5", classLevel: "c1", limit: "all" },
      res
    );
    expect(auditRows(res).map((r) => r.testId).sort()).toEqual(["test-1", "test-multi"]);

    // Grade 6 exists in the fixture set only outside this session → empty.
    const empty = mockRes();
    await getMarksAuditService({ session: "sess-1", grade: "6" }, empty);
    expect(auditRows(empty)).toEqual([]);
  });
});

// ── Subject cascade (last level) ─────────────────────────────────────────────
describe("getMarksAuditService — subject filter", () => {
  // Two subjects under the same session/grade, one of them also outside it, so
  // the filter can be checked on its own and composed with the levels above.
  const TEST_MATH = { ...TEST_ONE, _id: "test-1", subject: { _id: "s1", name: "Math" } };
  const TEST_BIO = {
    ...TEST_ONE,
    _id: "test-bio",
    name: "Weekly Test 1 (Biology)",
    subject: { _id: "s2", name: "Bio", displayName: "Biology" },
  };
  const TEST_BIO_OTHER = {
    ...TEST_TWO,
    _id: "test-bio-2",
    name: "Weekly Test 2 (Biology)",
    subject: { _id: "s2", name: "Bio", displayName: "Biology" },
    classLevels: [{ _id: "c3", name: "Grade 6 — Red", gradeLevel: "6" }],
  };

  beforeEach(() => {
    mockTestFind.mockReturnValue(chainQuery([TEST_MATH, TEST_BIO, TEST_BIO_OTHER]));
  });

  test("rows expose subjectId and the phase's order for the cascade", async () => {
    const res = mockRes();
    await getMarksAuditService({ limit: "all" }, res);

    const row = auditRows(res).find((r) => r.testId === "test-bio");
    // The id keys the filter; the label stays the display name.
    expect(row.subjectId).toBe("s2");
    expect(row.subject).toBe("Biology");
    // `order` comes from the owning session's phases subdoc.
    expect(row.phaseOrder).toBe(1);

    // A standalone test has no subject-less quirk here, but no phase either.
    const standalone = auditRows(res).find((r) => r.testId === "test-bio-2");
    expect(standalone.subjectId).toBe("s2");
    expect(standalone.phaseOrder).toBeNull();
  });

  test("subject filter matches the id, or any part of its label", async () => {
    const byId = mockRes();
    await getMarksAuditService({ subject: "s2", limit: "all" }, byId);
    expect(auditRows(byId).map((r) => r.testId).sort()).toEqual(["test-bio", "test-bio-2"]);

    // Direct API queries by name stay usable (case-insensitive substring).
    const byName = mockRes();
    await getMarksAuditService({ subject: "biolog", limit: "all" }, byName);
    expect(auditRows(byName).map((r) => r.testId).sort()).toEqual(["test-bio", "test-bio-2"]);

    const unknown = mockRes();
    await getMarksAuditService({ subject: "s999" }, unknown);
    expect(auditRows(unknown)).toEqual([]);
  });

  test("subject composes with the session and grade levels above it", async () => {
    const res = mockRes();
    await getMarksAuditService(
      { session: "sess-1", grade: "5", phase: "ph-1", subject: "s2", limit: "all" },
      res
    );
    expect(auditRows(res).map((r) => r.testId)).toEqual(["test-bio"]);

    // Biology's other test sits in grade 6 → this combination is empty.
    const empty = mockRes();
    await getMarksAuditService({ grade: "6", subject: "s1", limit: "all" }, empty);
    expect(auditRows(empty)).toEqual([]);
  });

  test("week narrows the level below it (subject) as well", async () => {
    // Both fixtures under Week 3 carry Biology, the standalone one does not.
    const res = mockRes();
    await getMarksAuditService(
      { session: "sess-1", grade: "5", phase: "ph-1", week: "w-1", subject: "s2", limit: "all" },
      res
    );
    expect(auditRows(res).map((r) => r.testId)).toEqual(["test-bio"]);

    // "none" keeps the week-less test — the very one the week above excludes.
    const noWeek = mockRes();
    await getMarksAuditService({ subject: "s2", week: "none", limit: "all" }, noWeek);
    expect(auditRows(noWeek).map((r) => r.testId)).toEqual(["test-bio-2"]);
  });
});

// ── Marking status: completion, flags, ordering ──────────────────────────────
describe("getMarksAuditService — marked / unmarked status", () => {
  test("a test is marked only when every student of its classes has a score", async () => {
    const res = mockRes();
    await getMarksAuditService({ limit: "all" }, res);
    const rows = auditRows(res);

    // c1 holds exactly the three marked pupils → complete.
    const done = rows.find((r) => r.testId === "test-1");
    expect(done.expectedCount).toBe(3);
    expect(done.fullyMarked).toBe(true);
    expect(done.status).toBe("marked");

    // Nothing entered for a class of one → outstanding.
    const partial = rows.find((r) => r.testId === "test-2");
    expect(partial.expectedCount).toBe(3);
    expect(partial.markedCount).toBe(0);
    expect(partial.fullyMarked).toBe(false);
    expect(partial.status).toBe("unmarked");

    // An empty class can never be "completed".
    const childless = rows.find((r) => r.testId === "test-3");
    expect(childless.expectedCount).toBe(0);
    expect(childless.fullyMarked).toBe(false);
    expect(childless.status).toBe("unmarked");
  });

  test("partially marked tests stay unmarked", async () => {
    // Grow c1 to 5 students so that 3 of them marked still means outstanding.
    mockStudentFind.mockReturnValue(
      chainQuery([...STUDENT_ROWS, { classLevel: "c1" }, { classLevel: "c1" }])
    );

    const res = mockRes();
    await getMarksAuditService({ limit: "all" }, res);
    const row = auditRows(res).find((r) => r.testId === "test-1");
    expect(row.expectedCount).toBe(5);
    expect(row.markedCount).toBe(3);
    expect(row.fullyMarked).toBe(false);
    expect(row.status).toBe("unmarked");
  });

  test("inactive / graduated / withdrawn students are not expected to be marked", async () => {
    // The service asks the Student collection for active pupils only; a roster
    // made of the three marked ones plus an inactive fourth still completes.
    const res = mockRes();
    await getMarksAuditService({ limit: "all" }, res);
    const row = auditRows(res).find((r) => r.testId === "test-1");
    expect(row.fullyMarked).toBe(true);

    const query = mockStudentFind.mock.calls[0][0];
    expect(query).toMatchObject({
      status: { $ne: "inactive" },
      isGraduated: { $ne: true },
      isWithdrawn: { $ne: true },
    });
  });

  test("a fully marked test is never overdue or critical and sinks to the bottom", async () => {
    const res = mockRes();
    await getMarksAuditService({ limit: "all" }, res);
    const rows = auditRows(res);

    // test-1 is dated 18 days back — overdue and critical while outstanding,
    // but its marks are complete…
    const done = rows.find((r) => r.testId === "test-1");
    expect(done.overdue).toBe(false);
    expect(done.critical).toBe(false);

    // …while the still-unmarked test-2 keeps its flag (and, at 11 days, the
    // red critical one) and leads the ledger.
    const pending = rows.find((r) => r.testId === "test-2");
    expect(pending.overdue).toBe(true);
    expect(pending.critical).toBe(true);
    expect(rows[0].testId).toBe("test-2");
    expect(rows[rows.length - 1].testId).toBe("test-1");
  });

  test("status filter narrows the ledger to marked / unmarked", async () => {
    const marked = mockRes();
    await getMarksAuditService({ status: "marked", limit: "all" }, marked);
    expect(auditRows(marked).map((r) => r.testId)).toEqual(["test-1"]);

    const unmarked = mockRes();
    await getMarksAuditService({ status: "unmarked", limit: "all" }, unmarked);
    expect(auditRows(unmarked).map((r) => r.testId).sort()).toEqual(["test-2", "test-3"]);

    // Anything else (typos, blanks) is not a status: no narrowing.
    const all = mockRes();
    await getMarksAuditService({ status: "everything", limit: "all" }, all);
    expect(auditRows(all)).toHaveLength(3);
  });

  test("status composes with the category cascade", async () => {
    const res = mockRes();
    await getMarksAuditService({ status: "unmarked", session: "none", limit: "all" }, res);
    expect(auditRows(res).map((r) => r.testId)).toEqual(["test-2", "test-3"]);
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
