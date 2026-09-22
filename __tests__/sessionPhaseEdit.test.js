/**
 * Session phase-editing tests (admin/manager "edit test session" feature).
 *
 * Covers:
 *   - addPhaseService: appends a phase with the next order value
 *   - updateTestSessionService: renames, adds new phases, keeps existing
 *     phases (by _id), and cascade-purges removed phases (weeks deleted,
 *     tests unlinked)
 *
 * All models are mocked at the data layer so the real service logic executes
 * without a database.
 */

// ── Shared mock res factory ──────────────────────────────────────────────────
function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockSessionFindById = jest.fn();

const mockWeekFind = jest.fn();
const mockWeekDeleteMany = jest.fn();

const mockTestUpdateMany = jest.fn();

jest.mock("../models/Academic/testSession.model", () => ({
  findById: (...a) => mockSessionFindById(...a),
}));

jest.mock("../models/Academic/week.model", () => ({
  find: (...a) => mockWeekFind(...a),
  deleteMany: (...a) => mockWeekDeleteMany(...a),
}));

jest.mock("../models/Academic/test.model", () => ({
  updateMany: (...a) => mockTestUpdateMany(...a),
}));

// ── Require services AFTER mocks ─────────────────────────────────────────────
const { addPhaseService, updateTestSessionService } = require("../services/academic/testSession.service");

// ── Helpers ──────────────────────────────────────────────────────────────────
const SESSION_ID = "session-1";

/** Lightweight stand-in for a Mongoose TestSession document. */
function makeSessionDoc(phases, extra = {}) {
  const doc = {
    _id: SESSION_ID,
    name: "Term 1 Sessions",
    classLevels: [],
    phases,
    saved: false,
    saveCalledAfterWeekDelete: false,
    save() {
      this.saved = true;
      // Capture whether the cascade cleanup already ran before save()
      this.saveCalledAfterWeekDelete = mockWeekDeleteMany.mock.calls.length > 0;
      return Promise.resolve(this);
    },
    ...extra,
  };
  return doc;
}

/** Week.find({session, phase}).distinct("_id") chain mock. */
function setupWeekFind(phaseToWeekIds) {
  mockWeekFind.mockImplementation((query) => ({
    distinct: () => Promise.resolve(phaseToWeekIds[query.phase] || []),
  }));
}

beforeEach(() => jest.clearAllMocks());

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ADD PHASE
// ═══════════════════════════════════════════════════════════════════════════════

describe("addPhaseService", () => {
  test("appends a new phase with the next order value", async () => {
    const doc = makeSessionDoc([
      { _id: { toString: () => "p1" }, name: "Phase 1", order: 1 },
      { _id: { toString: () => "p2" }, name: "Phase 2", order: 2 },
    ]);
    mockSessionFindById.mockResolvedValue(doc);

    const res = mockRes();
    await addPhaseService(SESSION_ID, " Phase 3 ", res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(doc.phases).toHaveLength(3);
    expect(doc.phases[2]).toEqual({ name: "Phase 3", order: 3 });
    expect(doc.saved).toBe(true);
  });

  test("rejects an empty phase name", async () => {
    mockSessionFindById.mockResolvedValue(makeSessionDoc([]));

    const res = mockRes();
    await addPhaseService(SESSION_ID, "   ", res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSessionFindById).not.toHaveBeenCalled();
  });

  test("returns 404 when session not found", async () => {
    mockSessionFindById.mockResolvedValue(null);

    const res = mockRes();
    await addPhaseService("missing", "Phase 1", res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. UPDATE SESSION (add / keep / remove phases)
// ═══════════════════════════════════════════════════════════════════════════════

describe("updateTestSessionService", () => {
  test("renames, keeps existing phases, adds new ones, and purges removed ones", async () => {
    const doc = makeSessionDoc([
      { _id: { toString: () => "keep-1" }, name: "Phase 1", order: 1 },
      { _id: { toString: () => "drop-1" }, name: "Phase 2", order: 2 },
    ]);
    mockSessionFindById.mockResolvedValue(doc);
    setupWeekFind({ "drop-1": ["week-a", "week-b"] });

    const res = mockRes();
    await updateTestSessionService(
      SESSION_ID,
      {
        name: "Term 1 Revised",
        classLevels: ["class-1"],
        phases: [
          { _id: "keep-1", name: "Unit Tests", order: 1 }, // rename in place
          { name: "Finals", order: 2 },                     // brand-new phase
        ],
      },
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(doc.name).toBe("Term 1 Revised");
    expect(doc.classLevels).toEqual(["class-1"]);

    // Kept phase retained its _id (tests referencing it stay linked)
    expect(doc.phases[0]._id).toBe("keep-1");
    expect(doc.phases[0].name).toBe("Unit Tests");
    // New phase has no _id — Mongoose would auto-generate on save
    expect(doc.phases[1]).toEqual({ name: "Finals", order: 2 });

    // Removed phase "drop-1": its weeks' tests unlinked, weeks deleted
    expect(mockTestUpdateMany).toHaveBeenCalledWith(
      { week: { $in: ["week-a", "week-b"] } },
      { $set: { week: null } }
    );
    expect(mockTestUpdateMany).toHaveBeenCalledWith(
      { session: SESSION_ID, phase: "drop-1" },
      { $set: { session: null, phase: null, week: null } }
    );
    expect(mockWeekDeleteMany).toHaveBeenCalledWith({ session: SESSION_ID, phase: "drop-1" });

    // Cleanup of the removed phase happened BEFORE the save
    expect(doc.saved).toBe(true);
    expect(doc.saveCalledAfterWeekDelete).toBe(true);
  });

  test("purges dependents of ALL removed phases", async () => {
    const doc = makeSessionDoc([
      { _id: { toString: () => "p1" }, name: "Phase 1", order: 1 },
      { _id: { toString: () => "p2" }, name: "Phase 2", order: 2 },
      { _id: { toString: () => "p3" }, name: "Phase 3", order: 3 },
    ]);
    mockSessionFindById.mockResolvedValue(doc);
    setupWeekFind({}); // no weeks anywhere

    const res = mockRes();
    await updateTestSessionService(
      SESSION_ID,
      { phases: [{ _id: "p1", name: "Phase 1", order: 1 }] },
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    // p2 and p3 purged; p1 untouched
    expect(mockWeekDeleteMany).toHaveBeenCalledWith({ session: SESSION_ID, phase: "p2" });
    expect(mockWeekDeleteMany).toHaveBeenCalledWith({ session: SESSION_ID, phase: "p3" });
    expect(mockWeekDeleteMany).not.toHaveBeenCalledWith({ session: SESSION_ID, phase: "p1" });
    expect(doc.phases).toHaveLength(1);
  });

  test("rejects an update that would leave the session with no phases", async () => {
    const doc = makeSessionDoc([
      { _id: { toString: () => "p1" }, name: "Phase 1", order: 1 },
    ]);
    mockSessionFindById.mockResolvedValue(doc);

    const res = mockRes();
    await updateTestSessionService(SESSION_ID, { name: "X", phases: [] }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(doc.saved).toBe(false);
    expect(mockWeekDeleteMany).not.toHaveBeenCalled();
  });

  test("returns 404 when session not found", async () => {
    mockSessionFindById.mockResolvedValue(null);

    const res = mockRes();
    await updateTestSessionService("missing", { phases: [{ name: "P" }] }, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
