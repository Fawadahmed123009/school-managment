/**
 * Tests for updating a test's total / pass marks from the mark-entry page.
 *
 * The teacher fixing a wrong score scale must not be able to:
 *   • store an invalid scale (total < 1, negative pass, pass > total)
 *   • shrink the total below scores that were already entered — that would
 *     leave results that exceed the test maximum.
 * Raising the total, or shrinking it while every entered score still fits,
 * must succeed.
 *
 * Models are mocked at the data layer; the real service validation executes.
 */

const mockTestFindById = jest.fn();
const mockResultFind = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  findById: (...a) => {
    const result = mockTestFindById(...a);
    // Support .select() chaining used by getTestMarksService.
    const promise = Promise.resolve(result);
    promise.select = jest.fn().mockReturnValue(promise);
    return promise;
  },
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockResultFind(...a),
}));

const {
  updateTestMarksService,
  getTestMarksService,
} = require("../services/academic/test.service");

// ── Helpers ──────────────────────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Test document with a spy-able save(). */
function mockTestDoc(overrides = {}) {
  const doc = {
    _id: "test-1",
    totalMarks: 100,
    passMarks: 40,
    save: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
  doc.save.mockResolvedValue(doc);
  return doc;
}

/** TestResult.find(query) chain → resolves a list of results with given scores. */
function mockExistingScores(scores) {
  const docs = scores.map((s, i) => ({
    _id: `r${i}`,
    student: { name: `Student ${i}` },
    score: s,
  }));
  mockResultFind.mockImplementation((q) => {
    const gt = q && q.score && q.score.$gt !== undefined ? q.score.$gt : Infinity;
    const filtered = docs.filter((d) => d.score > gt);
    const promise = Promise.resolve(filtered);
    promise.populate = jest.fn().mockReturnValue(promise);
    return promise;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExistingScores([]);
});

// ── Scale validation ─────────────────────────────────────────────────────────
describe("updateTestMarksService — validates the new scale", () => {
  test("rejects a total below 1", async () => {
    const res = mockRes();
    await updateTestMarksService("test-1", { totalMarks: 0, passMarks: 0 }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/Total marks/i);
  });

  test("rejects non-numeric input", async () => {
    const res = mockRes();
    await updateTestMarksService("test-1", { totalMarks: "abc", passMarks: 10 }, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test("rejects negative pass marks", async () => {
    const res = mockRes();
    await updateTestMarksService("test-1", { totalMarks: 50, passMarks: -1 }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/Pass marks/i);
  });

  test("rejects pass marks above total marks", async () => {
    const res = mockRes();
    await updateTestMarksService("test-1", { totalMarks: 50, passMarks: 60 }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/cannot exceed/i);
  });
});

// ── Data safety ──────────────────────────────────────────────────────────────
describe("updateTestMarksService — protects already-entered scores", () => {
  test("refuses to lower the total below an entered score and does not save", async () => {
    mockExistingScores([25, 30]); // $gt 20 → both violate a new total of 20

    const res = mockRes();
    const doc = mockTestDoc({ totalMarks: 100, passMarks: 40 });
    mockTestFindById.mockReturnValue(doc);

    await updateTestMarksService("test-1", { totalMarks: 20, passMarks: 10 }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/exceed it/i);
    expect(doc.save).not.toHaveBeenCalled();
  });

  test("allows lowering the total when every entered score still fits", async () => {
    const doc = mockTestDoc({ totalMarks: 100, passMarks: 40 });
    mockTestFindById.mockReturnValue(doc);
    mockExistingScores([15, 20]); // $gt 50 → none

    const res = mockRes();
    await updateTestMarksService("test-1", { totalMarks: 50, passMarks: 20 }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.totalMarks).toBe(50);
    expect(doc.passMarks).toBe(20);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  test("allows raising the total with no score check performed", async () => {
    const doc = mockTestDoc({ totalMarks: 100, passMarks: 40 });
    mockTestFindById.mockReturnValue(doc);

    const res = mockRes();
    await updateTestMarksService("test-1", { totalMarks: 150, passMarks: 60 }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.totalMarks).toBe(150);
    expect(doc.passMarks).toBe(60);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  test("404s for a nonexistent test", async () => {
    mockTestFindById.mockReturnValue(null);

    const res = mockRes();
    await updateTestMarksService("missing", { totalMarks: 100, passMarks: 40 }, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ── Read scale (scan & enter marks page) ─────────────────────────────────────
describe("getTestMarksService — returns only the score scale", () => {
  test("exposes totalMarks / passMarks without shipping the roster", async () => {
    mockTestFindById.mockReturnValue({
      _id: "test-1",
      name: "Mid Term",
      totalMarks: 80,
      passMarks: 32,
    });

    const res = mockRes();
    await getTestMarksService("test-1", res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({
      _id: "test-1",
      name: "Mid Term",
      totalMarks: 80,
      passMarks: 32,
    });
  });

  test("404s for a nonexistent test", async () => {
    mockTestFindById.mockReturnValue(null);

    const res = mockRes();
    await getTestMarksService("missing", res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
