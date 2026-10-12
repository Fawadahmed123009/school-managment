/**
 * N+1 regression tests for test.service.js class lookups.
 *
 * Two hot paths used to issue one ClassLevel query per item:
 *   • validateSubjectClassScope — ClassLevel.findById per classLevel (create/edit test)
 *   • resolveClassTokens        — ClassLevel.find per "grade:<level>" token (analytics)
 *
 * Both are now consolidated into a single batched `$in` query.  These tests
 * assert the query SHAPE and CALL COUNT, and — crucially — that per-item
 * validation behavior is preserved (a batched `$in` must still reject a set
 * that contains one invalid class, and must name the offending class).
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const mockClassLevelFind = jest.fn();
const mockClassLevelFindById = jest.fn();
const mockSubjectFindById = jest.fn();

jest.mock("../models/Academic/class.model", () => ({
  find: (...a) => mockClassLevelFind(...a),
  findById: (...a) => mockClassLevelFindById(...a),
}));
jest.mock("../models/Academic/subject.model", () => ({
  findById: (...a) => mockSubjectFindById(...a),
}));

const {
  validateSubjectClassScope,
  resolveClassTokens,
} = require("../services/academic/test.service");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const C1 = "507f1f77bcf86cd799439101";
const C2 = "507f1f77bcf86cd799439102";
const C3 = "507f1f77bcf86cd799439103";

const CLASSES = [
  { _id: C1, name: "1-A", gradeLevel: "1", group: null },
  { _id: C2, name: "2-A", gradeLevel: "2", group: null },
  { _id: C3, name: "3-A", gradeLevel: "3", group: null },
];

// A thenable-with-.lean() chain that mirrors how the real driver resolves the
// two query shapes the service issues: { _id: { $in } } and { gradeLevel: ... }.
function classQuery(query) {
  let out = CLASSES.slice();
  if (query && query._id && query._id.$in) {
    const ids = query._id.$in.map(String);
    out = out.filter((c) => ids.includes(String(c._id)));
  }
  if (query && query.gradeLevel) {
    const gl = query.gradeLevel;
    if (Array.isArray(gl.$in)) {
      const grades = gl.$in.map(String);
      out = out.filter((c) => grades.includes(String(c.gradeLevel)));
    } else {
      out = out.filter((c) => String(c.gradeLevel) === String(gl));
    }
  }
  const q = {
    select: () => q,
    sort: () => q,
    lean: () => Promise.resolve(out),
  };
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClassLevelFind.mockImplementation((query) => classQuery(query));
});

// ═════════════════════════════════════════════════════════════════════════════
// validateSubjectClassScope — one batched _id:$in query, per-item behavior kept
// ═════════════════════════════════════════════════════════════════════════════
describe("validateSubjectClassScope — single query + preserved rejection", () => {
  const SUBJECT_ID = "sub-1";
  const subjectWithAll = {
    _id: SUBJECT_ID,
    name: "Math",
    appliesTo: [{ gradeLevel: "1" }, { gradeLevel: "2" }, { gradeLevel: "3" }],
  };

  test("resolves ALL classLevels in ONE find and issues NO findById (was N+1)", async () => {
    mockSubjectFindById.mockResolvedValue(subjectWithAll);

    const err = await validateSubjectClassScope(SUBJECT_ID, [C1, C2, C3]);

    expect(err).toBeNull(); // valid set → in scope
    expect(mockClassLevelFind).toHaveBeenCalledTimes(1);
    expect(mockClassLevelFindById).not.toHaveBeenCalled();
    // The single query carries every id via $in.
    expect(mockClassLevelFind.mock.calls[0][0]).toEqual({
      _id: { $in: [C1, C2, C3] },
    });
  });

  test("rejects a set that mixes in ONE unknown id with 404 'Class not found'", async () => {
    // Subject would accept everything; the invalid id simply won't come back
    // from the batched find, so the class must still be rejected — not accepted.
    mockSubjectFindById.mockResolvedValue(subjectWithAll);
    const UNKNOWN = "507f1f77bcf86cd799439999";

    const err = await validateSubjectClassScope(SUBJECT_ID, [C1, UNKNOWN]);

    expect(err).toEqual({ code: 404, message: "Class not found" });
    expect(mockClassLevelFind).toHaveBeenCalledTimes(1);
    expect(mockClassLevelFindById).not.toHaveBeenCalled();
  });

  test("names the FIRST out-of-scope class in the 400 message (order preserved)", async () => {
    // Subject taught only in grade 1. classLevels order: C2(grade 2) first, so
    // that is the class named in the rejection.
    mockSubjectFindById.mockResolvedValue({
      _id: SUBJECT_ID,
      name: "Math",
      appliesTo: [{ gradeLevel: "1" }],
    });

    const err = await validateSubjectClassScope(SUBJECT_ID, [C2, C3]);

    expect(err.code).toBe(400);
    expect(err.message).toMatch(/is not taught in/i);
    expect(err.message).toMatch(/2-A/); // the offending class, not 3-A
    expect(mockClassLevelFind).toHaveBeenCalledTimes(1);
  });

  test("specific appliesTo entry still matches on exact class id after batching", async () => {
    mockSubjectFindById.mockResolvedValue({
      _id: SUBJECT_ID,
      name: "Physics",
      appliesTo: [{ classLevel: C1 }],
    });

    const err = await validateSubjectClassScope(SUBJECT_ID, [C1]);
    expect(err).toBeNull();

    const errBad = await validateSubjectClassScope(SUBJECT_ID, [C1, C2]);
    expect(errBad).toMatchObject({ code: 400 });
  });

  test("empty classLevels list makes NO query and is accepted (no false reject)", async () => {
    mockSubjectFindById.mockResolvedValue(subjectWithAll);

    const err = await validateSubjectClassScope(SUBJECT_ID, []);

    expect(err).toBeNull();
    expect(mockClassLevelFind).not.toHaveBeenCalled();
  });

  test("missing subject short-circuits before any class query", async () => {
    mockSubjectFindById.mockResolvedValue(null);

    const err = await validateSubjectClassScope("nope", [C1]);

    expect(err).toEqual({ code: 404, message: "Subject not found" });
    expect(mockClassLevelFind).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// resolveClassTokens — one grade query for ALL grade tokens (was one per token)
// ═════════════════════════════════════════════════════════════════════════════
describe("resolveClassTokens — batched grade resolution", () => {
  const gradeQueries = () =>
    mockClassLevelFind.mock.calls.filter((c) => c[0] && c[0].gradeLevel);

  test("two grade tokens resolve via a SINGLE gradeLevel:$in query", async () => {
    const classes = await resolveClassTokens("grade:1,grade:2");

    // Exactly one query touches gradeLevel, and it carries both grades at once.
    const gq = gradeQueries();
    expect(gq).toHaveLength(1);
    expect(gq[0][0].gradeLevel).toEqual({ $in: ["1", "2"] });

    // And it produced the union of both grades' classes.
    expect(classes.map((c) => String(c._id)).sort()).toEqual([C1, C2].sort());
  });

  test("three grade tokens still cost a single grade query", async () => {
    await resolveClassTokens("grade:1,grade:2,grade:3");
    const gq = gradeQueries();
    expect(gq).toHaveLength(1);
    expect(gq[0][0].gradeLevel).toEqual({ $in: ["1", "2", "3"] });
  });

  test("mixes grade tokens with explicit ids without extra grade queries", async () => {
    const classes = await resolveClassTokens(`grade:1,${C3}`);
    // grade:1 → C1; explicit C3 kept. Union = {C1, C3}.
    expect(classes.map((c) => String(c._id)).sort()).toEqual([C1, C3].sort());
    // One grade query, one final _id:$in query.
    expect(gradeQueries()).toHaveLength(1);
    const finalQuery = mockClassLevelFind.mock.calls.find(
      (c) => c[0] && c[0]._id && c[0]._id.$in
    );
    expect(finalQuery).toBeTruthy();
  });

  test("no grade tokens → no grade query at all (ids only)", async () => {
    await resolveClassTokens(`${C1},${C2}`);
    expect(gradeQueries()).toHaveLength(0);
  });

  test("empty / null param returns [] without querying", async () => {
    expect(await resolveClassTokens("")).toEqual([]);
    expect(await resolveClassTokens(null)).toEqual([]);
    expect(mockClassLevelFind).not.toHaveBeenCalled();
  });
});
