/**
 * Combined-subject analytics — pools EVERY test of one subject into one view.
 *
 * Covers the percent-normalised pooling that makes tests scored out of different
 * totals comparable, the absent exclusion rule (an absence shows "A" but drops
 * out of every statistic), the per-test breakdown, the per-pupil combined marks
 * list, and the pure helpers the combined PDF shares.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockSubjectFindById = jest.fn();
const mockTestFind = jest.fn();
const mockTestResultFind = jest.fn();
const mockStudentFind = jest.fn();
const mockClassLevelFind = jest.fn();

// Chainable data-layer mock: records populate()/select()/sort() and resolves to
// the supplied rows on .lean() (or when awaited directly).
function mockChain(data) {
  const c = {};
  ["select", "sort", "populate"].forEach((m) => { c[m] = () => c; });
  c.lean = () => Promise.resolve(data);
  c.then = (res, rej) => Promise.resolve(data).then(res, rej);
  return c;
}

const SUBJECT_ID = "507f1f77bcf86cd799439011";
const CLASS_A = "507f1f77bcf86cd799439033";
const STUDENT_A = "507f1f77bcf86cd7994390cc";
const STUDENT_B = "507f1f77bcf86cd7994390dd";
const TEST_1 = "507f1f77bcf86cd7994390ee"; // out of 100
const TEST_2 = "507f1f77bcf86cd7994390ef"; // out of 50

// Two tests of the SAME subject, different total marks.
const MOCK_TESTS = [
  { _id: TEST_1, name: "Midterm Math", date: new Date("2026-01-10"), totalMarks: 100,
    classLevels: [{ _id: CLASS_A, name: "9-A" }] },
  { _id: TEST_2, name: "Quiz Math", date: new Date("2026-02-10"), totalMarks: 50,
    classLevels: [{ _id: CLASS_A, name: "9-A" }] },
];

// A: 80/100 (80%) + 45/50 (90%).  B: 40/100 (40%) + absent on the quiz.
const MOCK_RESULTS = [
  { test: TEST_1, student: { _id: STUDENT_A }, score: 80, absent: false },
  { test: TEST_1, student: { _id: STUDENT_B }, score: 40, absent: false },
  { test: TEST_2, student: { _id: STUDENT_A }, score: 45, absent: false },
  { test: TEST_2, student: { _id: STUDENT_B }, score: 0, absent: true },
];

const MOCK_STUDENTS = [
  { _id: STUDENT_A, name: "Ali Khan", studentId: "AK", rollNumber: "7", classLevel: { _id: CLASS_A, name: "9-A" } },
  { _id: STUDENT_B, name: "Sara Malik", studentId: "SM", rollNumber: "12", classLevel: { _id: CLASS_A, name: "9-A" } },
];

jest.mock("../models/Academic/subject.model", () => ({
  findById: (...a) => { mockSubjectFindById(...a); return mockChain({ _id: SUBJECT_ID, name: "Math", displayName: "Math" }); },
  find: () => mockChain([]),
}));
jest.mock("../models/Academic/test.model", () => ({
  find: (...a) => { mockTestFind(...a); return mockChain(MOCK_TESTS); },
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (q) => { mockTestResultFind(q); return mockChain(MOCK_RESULTS); },
}));
jest.mock("../models/Students/students.model", () => ({
  find: (...a) => { mockStudentFind(...a); return mockChain(MOCK_STUDENTS); },
}));
jest.mock("../models/Academic/class.model", () => ({
  find: (...a) => { mockClassLevelFind(...a); return mockChain([{ _id: CLASS_A, name: "9-A", gradeLevel: "9", section: "Boys" }]); },
}));

const {
  getCombinedSubjectAnalyticsService,
  percentStats,
  buildPercentDistribution,
} = require("../services/academic/test.service");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const sent = (res) => res.json.mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("percentStats / buildPercentDistribution (pure helpers)", () => {
  test("empty input yields a null-valued stat object", () => {
    expect(percentStats([])).toEqual({ avg: null, max: null, min: null, stddev: null, count: 0 });
  });
  test("averages / min / max over a percent list", () => {
    expect(percentStats([80, 40, 90])).toMatchObject({ avg: 70, min: 40, max: 90, count: 3 });
  });
  test("histogram buckets percentages into ten 0–100 bins", () => {
    const buckets = buildPercentDistribution([80, 40, 90, 100]);
    expect(buckets).toHaveLength(10);
    expect(buckets[4].count).toBe(1); // 40–50
    expect(buckets[8].count).toBe(1); // 80–90
    expect(buckets[9].count).toBe(2); // 90–100 (90 and 100 both clamp into the top bin)
  });
});

describe("getCombinedSubjectAnalyticsService", () => {
  test("requires a subject", async () => {
    const res = mockRes();
    await getCombinedSubjectAnalyticsService({}, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("pools every test of the subject into percent-normalised avg/min/max", async () => {
    const res = mockRes();
    await getCombinedSubjectAnalyticsService({ subjectId: SUBJECT_ID }, res);

    const data = sent(res);
    // Average pools every attempt: 80, 40, 90 → 70% (the quiz absence excluded).
    // Highest / Lowest are STUDENT-level (best/worst pupil's own overall %):
    // Ali 85% (80,90) is highest, Sara 40% (only the non-absent attempt) lowest.
    expect(data.pooled).toMatchObject({ avg: 70, min: 40, max: 85, count: 3 });
    expect(data.resultCount).toBe(2);
    expect(data.columns.map((c) => c.testId)).toEqual([TEST_1, TEST_2]);
  });

  test("per-test breakdown reports each test's own stats", async () => {
    const res = mockRes();
    await getCombinedSubjectAnalyticsService({ subjectId: SUBJECT_ID }, res);

    const [t1, t2] = sent(res).perTest;
    expect(t1).toMatchObject({ testId: TEST_1, totalMarks: 100, count: 2, avg: 60, min: 40, max: 80 });
    expect(t2).toMatchObject({ testId: TEST_2, totalMarks: 50, count: 1, avg: 90, min: 90, max: 90, absentCount: 1 });
  });

  test("combined marks list carries one cell per test and a per-pupil overall %", async () => {
    const res = mockRes();
    await getCombinedSubjectAnalyticsService({ subjectId: SUBJECT_ID }, res);

    const rows = sent(res).marksRows;
    const ali = rows.find((r) => r.name === "Ali Khan");
    const sara = rows.find((r) => r.name === "Sara Malik");

    expect(ali.cells[TEST_1]).toMatchObject({ percent: 80, absent: false });
    expect(ali.cells[TEST_2]).toMatchObject({ percent: 90 });
    expect(ali.overallPercent).toBe(85); // (80 + 90) / 2

    // Sara's quiz row is an absence: rendered as absent, excluded from her average.
    expect(sara.cells[TEST_1]).toMatchObject({ percent: 40 });
    expect(sara.cells[TEST_2]).toMatchObject({ absent: true, percent: null });
    expect(sara.overallPercent).toBe(40);
  });
});
