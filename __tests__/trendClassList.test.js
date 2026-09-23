/**
 * Trend — Class: the class-trend should list EVERY class as its own series
 * (so the comparison is populated by default), and honour the multi-select
 * filter when classes are ticked.
 *
 * Models are mocked at the data layer so the real service logic runs.
 */

// ── Chainable data-layer mock (must be `mock`-prefixed for jest.mock scope) ──
function mockChain(data) {
  const c = {};
  ["select", "populate", "sort"].forEach((m) => { c[m] = () => c; });
  c.lean = () => Promise.resolve(data);
  c.then = (res, rej) => Promise.resolve(data).then(res, rej);
  return c;
}

const mockCLASS_A = "507f1f77bcf86cd799439033";
const mockCLASS_B = "507f1f77bcf86cd799439044";
const mockSUBJECT = "507f1f77bcf86cd799439011";

const mockCLASSES = [
  { _id: mockCLASS_A, name: "9-A", gradeLevel: "9", group: "Computer Science", toString: () => mockCLASS_A },
  { _id: mockCLASS_B, name: "9-B", gradeLevel: "9", group: "Biology", toString: () => mockCLASS_B },
];
const mockTESTS = [
  { _id: "t1", name: "Test 1", subject: { _id: mockSUBJECT, name: "Math" }, totalMarks: 100, date: new Date("2025-01-01") },
  { _id: "t2", name: "Test 2", subject: { _id: mockSUBJECT, name: "Math" }, totalMarks: 100, date: new Date("2025-02-01") },
];
const mockCls = (id) => ({ _id: id, name: id, toString: () => id });
const mockRESULTS = [
  { test: "t1", student: { _id: "sa1", classLevel: mockCls(mockCLASS_A) }, score: 80 },
  { test: "t1", student: { _id: "sa2", classLevel: mockCls(mockCLASS_A) }, score: 60 },
  { test: "t1", student: { _id: "sb1", classLevel: mockCls(mockCLASS_B) }, score: 40 },
  { test: "t2", student: { _id: "sa1", classLevel: mockCls(mockCLASS_A) }, score: 90 },
  { test: "t2", student: { _id: "sb1", classLevel: mockCls(mockCLASS_B) }, score: 50 },
  { test: "t2", student: { _id: "sb2", classLevel: mockCls(mockCLASS_B) }, score: 70 },
];

jest.mock("../models/Academic/class.model", () => ({
  find: (q) => {
    let data = mockCLASSES;
    if (q && q._id && q._id.$in) {
      const ids = q._id.$in.map(String);
      data = mockCLASSES.filter((c) => ids.includes(String(c._id)));
    }
    return mockChain(data);
  },
}));
jest.mock("../models/Academic/subject.model", () => ({ find: () => mockChain([{ _id: mockSUBJECT, name: "Math" }]) }));
jest.mock("../models/Academic/test.model", () => ({ find: () => mockChain(mockTESTS) }));
jest.mock("../models/Academic/testResult.model", () => ({ find: () => mockChain(mockRESULTS) }));
jest.mock("../models/Students/students.model", () => ({ find: () => mockChain([]) }));

const { getTestTrendService } = require("../services/academic/test.service");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
const sent = (res) => res.json.mock.calls[0][0].data;

test("Trend — Class with no selection lists every class as its own line", async () => {
  const res = mockRes();
  await getTestTrendService({ mode: "class", subjectId: mockSUBJECT }, res);
  const data = sent(res);

  expect(data.trend).toHaveLength(2);
  const a = data.trend.find((l) => l.className.includes("Computer Science"));
  const b = data.trend.find((l) => l.className.includes("Biology"));
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();

  // Class A: t1 = (80+60)/2 = 70, t2 = 90. Class B: t1 = 40, t2 = (50+70)/2 = 60.
  expect(a.points.map((p) => p.avgPercent)).toEqual([70, 90]);
  expect(b.points.map((p) => p.avgPercent)).toEqual([40, 60]);

  // Flat table rows carry the class name for every point.
  expect(data.tableRows).toHaveLength(4);
  expect(data.tableRows.every((r) => r.className)).toBe(true);
});

test("Trend — Class honours the multi-select filter (single class)", async () => {
  const res = mockRes();
  await getTestTrendService({ mode: "class", subjectId: mockSUBJECT, classLevelId: mockCLASS_A }, res);
  const data = sent(res);

  expect(data.trend).toHaveLength(1);
  expect(data.trend[0].className).toContain("Computer Science");
  expect(data.trend[0].points.map((p) => p.avgPercent)).toEqual([70, 90]);
});
