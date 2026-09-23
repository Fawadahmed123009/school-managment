/**
 * "Clone week's tests to a new week" feature — verification tests.
 *
 * Validates the core service logic (no HTTP/DB):
 *  1. Cloning a week with tests → new week + tests created with correct
 *     date shift (+7 days), no scores, fresh definitions.
 *  2. New week inherits session/phase from the source week.
 *  3. Cloning an empty week → preview reports NO_TESTS, execute throws.
 *  4. Preview never writes anything to the database.
 */

const mockWeekFindById = jest.fn();
const mockWeekCreate = jest.fn();
const mockTestFind = jest.fn();
const mockTestInsertMany = jest.fn();

// Chainable that satisfies Test.find().populate().populate().sort().lean()
const findChain = (docs) => {
  const obj = {};
  obj.populate = jest.fn().mockReturnValue(obj);
  obj.sort = jest.fn().mockReturnValue(obj);
  obj.lean = jest.fn().mockResolvedValue(docs);
  return obj;
};

jest.mock("../models/Academic/week.model", () => {
  const Model = function () {};
  Model.findById = (...a) => mockWeekFindById(...a);
  Model.create = (...a) => mockWeekCreate(...a);
  Model.find = jest.fn();
  Model.findByIdAndUpdate = jest.fn();
  Model.findByIdAndDelete = jest.fn();
  Model.aggregate = jest.fn().mockResolvedValue([]);
  return Model;
});

jest.mock("../models/Academic/test.model", () => {
  const Model = function () {};
  Model.find = (...a) => mockTestFind(...a);
  Model.insertMany = (...a) => mockTestInsertMany(...a);
  Model.create = jest.fn();
  Model.updateMany = jest.fn();
  Model.aggregate = jest.fn().mockResolvedValue([]);
  return Model;
});

jest.mock("../models/Academic/testSession.model", () => ({
  findById: jest.fn(),
  find: jest.fn(),
}));

const {
  buildCloneWeekPreviewService,
  executeCloneWeekService,
} = require("../services/academic/week.service");

const ADMIN_ID = "admin-abc";
const SOURCE_WEEK_ID = "week-src";
const SESSION_ID = "session-001";
const PHASE_ID = "phase-001";

// Source week runs 2025-10-06 → 2025-10-10.
const MOCK_SOURCE_WEEK = {
  _id: SOURCE_WEEK_ID,
  name: "Week 2",
  session: SESSION_ID,
  phase: PHASE_ID,
  startDate: new Date("2025-10-06T00:00:00.000Z"),
  endDate: new Date("2025-10-10T00:00:00.000Z"),
};

function sourceTests() {
  return [
    {
      _id: "t1",
      name: "Quiz 1",
      subject: { _id: "s1", name: "Math" },
      classLevels: [{ _id: "c1", name: "Grade 9" }],
      date: new Date("2025-10-07T00:00:00.000Z"),
      totalMarks: 50,
      passMarks: 20,
    },
    {
      _id: "t2",
      name: "Quiz 2",
      subject: { _id: "s2", name: "Science" },
      classLevels: [{ _id: "c1", name: "Grade 9" }],
      date: new Date("2025-10-09T00:00:00.000Z"),
      totalMarks: 40,
      passMarks: 16,
    },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWeekFindById.mockReturnValue({
    lean: jest.fn().mockResolvedValue(MOCK_SOURCE_WEEK),
  });
  mockTestFind.mockReturnValue(findChain(sourceTests()));
});

describe("Clone week preview", () => {
  test("computes +7 day date shift and lists tests to clone", async () => {
    const preview = await buildCloneWeekPreviewService(SOURCE_WEEK_ID, {
      name: "Week 3",
      startDate: "2025-10-13", // 7 days after source start (10-06)
      endDate: "2025-10-17",
    });

    expect(preview.error).toBeUndefined();
    expect(preview.shiftDays).toBe(7);
    expect(preview.tests).toHaveLength(2);
    // Original 10-07 → 10-14, 10-09 → 10-16
    expect(preview.tests[0].newDate.toISOString().slice(0, 10)).toBe("2025-10-14");
    expect(preview.tests[1].newDate.toISOString().slice(0, 10)).toBe("2025-10-16");
    expect(preview.newWeek.name).toBe("Week 3");

    // Preview must not create anything.
    expect(mockWeekCreate).not.toHaveBeenCalled();
    expect(mockTestInsertMany).not.toHaveBeenCalled();
  });

  test("reports NO_TESTS for an empty source week (no create)", async () => {
    mockTestFind.mockReturnValue(findChain([]));
    const preview = await buildCloneWeekPreviewService(SOURCE_WEEK_ID, {
      name: "Week 3",
      startDate: "2025-10-13",
      endDate: "2025-10-17",
    });
    expect(preview.error).toBe("NO_TESTS");
    expect(mockWeekCreate).not.toHaveBeenCalled();
    expect(mockTestInsertMany).not.toHaveBeenCalled();
  });

  test("rejects end date before start date", async () => {
    const preview = await buildCloneWeekPreviewService(SOURCE_WEEK_ID, {
      name: "Week 3",
      startDate: "2025-10-17",
      endDate: "2025-10-13",
    });
    expect(preview.error).toMatch(/end date/i);
  });
});

describe("Execute clone", () => {
  test("creates new week inheriting session/phase and clones fresh tests", async () => {
    mockWeekFindById.mockReturnValue(MOCK_SOURCE_WEEK); // non-lean for execute
    mockWeekCreate.mockImplementation(async (doc) => ({ _id: "week-new", ...doc }));
    mockTestInsertMany.mockImplementation(async (docs) => docs);

    const result = await executeCloneWeekService(
      SOURCE_WEEK_ID,
      { name: "Week 3", startDate: "2025-10-13", endDate: "2025-10-17" },
      ADMIN_ID
    );

    // New week structure matches the Week model.
    const createdWeek = mockWeekCreate.mock.calls[0][0];
    expect(createdWeek.session).toBe(SESSION_ID);
    expect(createdWeek.phase).toBe(PHASE_ID);
    expect(createdWeek.name).toBe("Week 3");
    expect(createdWeek.createdBy).toBe(ADMIN_ID);
    expect(new Date(createdWeek.startDate).toISOString().slice(0, 10)).toBe("2025-10-13");

    // Cloned tests: correct week ref, shifted dates, no scores, fresh flags.
    expect(result.testsCreated).toBe(2);
    const cloned = mockTestInsertMany.mock.calls[0][0];
    expect(cloned[0].week).toBe("week-new");
    expect(cloned[0].date.toISOString().slice(0, 10)).toBe("2025-10-14");
    expect(cloned[1].date.toISOString().slice(0, 10)).toBe("2025-10-16");
    // Definition copied, no results/submissions keys present.
    expect(cloned[0].name).toBe("Quiz 1");
    expect(cloned[0].subject).toBe("s1");
    expect(cloned[0].totalMarks).toBe(50);
    expect(cloned[0].passMarks).toBe(20);
    expect(cloned[0]).not.toHaveProperty("results");
    expect(cloned[0]).not.toHaveProperty("submissions");
    expect(cloned[0]).not.toHaveProperty("scores");
  });

  test("throws on empty source week (no week created)", async () => {
    mockWeekFindById.mockReturnValue(MOCK_SOURCE_WEEK);
    mockTestFind.mockReturnValue(findChain([]));

    await expect(
      executeCloneWeekService(
        SOURCE_WEEK_ID,
        { name: "Week 3", startDate: "2025-10-13", endDate: "2025-10-17" },
        ADMIN_ID
      )
    ).rejects.toThrow(/no tests to clone/i);

    expect(mockWeekCreate).not.toHaveBeenCalled();
    expect(mockTestInsertMany).not.toHaveBeenCalled();
  });
});
