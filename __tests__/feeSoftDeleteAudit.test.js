/**
 * C2 — fee records are money.
 *
 * Two invariants are asserted here:
 *
 *  1. Deleting a fee HIDES it, it never erases it. deleteFeeService flags
 *     `isDeleted / deletedAt / deletedBy`, and models/Fees/fees.model.js scopes
 *     every read, count, distinct, update and aggregation so the archived row
 *     cannot resurface or be silently edited — enforced at schema level so a
 *     future read path cannot forget the filter.
 *  2. Every mutation is attributable. An audit row (who / what / when) is
 *     written next to each change, and the write is fail-closed: if the audit
 *     row cannot be written, the mutation is rolled back or refused.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockFees = {
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  updateOne: jest.fn(),
  create: jest.fn(),
  // Must never be reached — asserted below.
  findByIdAndDelete: jest.fn(),
  deleteOne: jest.fn(),
  deleteMany: jest.fn(),
};
const mockFeeAudit = { create: jest.fn() };
const mockPaginate = jest.fn();

jest.mock("../models/Fees/fees.model", () => mockFees);
jest.mock("../models/Fees/feeAudit.model", () => mockFeeAudit);
jest.mock("../models/Fees/feeHead.model", () => ({}));
jest.mock("../models/Students/students.model", () => ({}));
jest.mock("../utils/paginate", () => ({ paginate: (...a) => mockPaginate(...a) }));
jest.mock("../services/fees/feeHead.service", () => ({
  findOrCreateFeeHeadByName: jest.fn(),
}));

// The real (unmocked) model, so the schema-level scoping hooks can be exercised
// without a database connection.
const RealFees = jest.requireActual("../models/Fees/fees.model");

const {
  deleteFeeService,
  updateFeeService,
  getFeeAuditService,
} = require("../services/fees/fees.service");

const ADMIN_ID = "admin-abc";
const FEE_ID = "fee-111";
const STUDENT_ID = "student-001";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRes() {
  const res = {};
  res.status = jest.fn().mockImplementation((code) => {
    res._statusCode = code;
    return res;
  });
  res.json = jest.fn().mockImplementation((body) => {
    res._body = body;
    return res;
  });
  return res;
}

/** A live (not yet deleted) fee document, as stored before the delete. */
function liveFee(overrides = {}) {
  return {
    _id: FEE_ID,
    student: STUDENT_ID,
    amount: 5000,
    status: "paid",
    feeType: "Tuition",
    billingMonth: "2026-09",
    datePaid: new Date("2026-09-05T00:00:00.000Z"),
    notes: "September tuition",
    recordedBy: ADMIN_ID,
    isDeleted: false,
    ...overrides,
  };
}

/** Fees.findById(id).lean() → the pre-image the audit snapshot is taken from. */
function stubFindById(doc) {
  mockFees.findById.mockReturnValue({ lean: async () => doc });
}

// Hooks are registered with regex operation matchers (^find, ^(updateOne|…),
// ^(deleteOne|…)), which mongoose expands to concrete hook names. Find the
// custom hook registered for a given operation.
const SCOPING_HOOK_SOURCE = /isSelfScoped|NOT_DELETED|allowHardDelete/;

function hookFor(opName) {
  const registered = RealFees.schema.s.hooks._pres.get(opName) || [];
  const hook = registered.find((h) => h.fn && SCOPING_HOOK_SOURCE.test(String(h.fn)));
  expect(hook).toBeDefined();
  return hook.fn;
}

function fakeQuery(filter = {}, options = {}) {
  return {
    _filter: filter,
    _options: options,
    getFilter() {
      return this._filter;
    },
    getOptions() {
      return this._options;
    },
    where(cond) {
      Object.assign(this._filter, cond);
      return this;
    },
  };
}

/** Run the scoping hook for `opName` against a fake query; throws if it refuses. */
function runHook(opName, query) {
  let error;
  hookFor(opName).call(query, (err) => {
    error = err;
  });
  if (error) throw error;
  return query.getFilter();
}

beforeEach(() => {
  // mockReset (not just clear) — a rejected/resolved stub set by one test must
  // not leak into the next one.
  [mockFees, mockFeeAudit].forEach((m) => Object.values(m).forEach((fn) => fn.mockReset()));
  mockPaginate.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. deleteFeeService — soft delete + audit, fail-closed
// ═════════════════════════════════════════════════════════════════════════════

describe("deleteFeeService — flags and records, never erases", () => {
  test("marks the record isDeleted with deletedAt/deletedBy instead of removing it", async () => {
    stubFindById(liveFee());
    mockFees.findOneAndUpdate.mockResolvedValue(liveFee({ isDeleted: true }));

    const res = makeRes();
    await deleteFeeService(FEE_ID, ADMIN_ID, res);

    expect(mockFees.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = mockFees.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: FEE_ID });
    expect(update.isDeleted).toBe(true);
    expect(update.deletedBy).toBe(ADMIN_ID);
    expect(update.deletedAt).toBeInstanceOf(Date);
    expect(options).toMatchObject({ new: true });

    // No hard-delete path was touched.
    expect(mockFees.findByIdAndDelete).not.toHaveBeenCalled();
    expect(mockFees.deleteOne).not.toHaveBeenCalled();
    expect(mockFees.deleteMany).not.toHaveBeenCalled();

    expect(res._statusCode).toBe(200);
  });

  test("writes an audit row naming who deleted it and a snapshot of what was removed", async () => {
    const before = liveFee();
    stubFindById(before);
    mockFees.findOneAndUpdate.mockResolvedValue({ ...before, isDeleted: true });

    await deleteFeeService(FEE_ID, ADMIN_ID, makeRes());

    expect(mockFeeAudit.create).toHaveBeenCalledTimes(1);
    const entry = mockFeeAudit.create.mock.calls[0][0];
    expect(entry.action).toBe("delete");
    expect(entry.actor).toBe(ADMIN_ID);
    expect(entry.fee).toBe(FEE_ID);
    expect(entry.student).toBe(STUDENT_ID);
    expect(entry.amount).toBe(5000);
    expect(entry.status).toBe("paid");
    // The snapshot preserves the money values as they were at deletion time.
    expect(entry.changes).toMatchObject({
      amount: 5000,
      status: "paid",
      billingMonth: "2026-09",
      recordedBy: ADMIN_ID,
    });
  });

  test("404s when the record is not visible — and writes no audit row", async () => {
    // A soft-deleted record is invisible to findById (schema scoping), so a
    // second delete / a stale id lands here.
    stubFindById(null);

    const res = makeRes();
    await deleteFeeService(FEE_ID, ADMIN_ID, res);

    expect(res._statusCode).toBe(404);
    expect(mockFees.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockFeeAudit.create).not.toHaveBeenCalled();
  });

  test("404s when the flag write matches nothing, without leaving a phantom audit row", async () => {
    stubFindById(liveFee());
    mockFees.findOneAndUpdate.mockResolvedValue(null);

    const res = makeRes();
    await deleteFeeService(FEE_ID, ADMIN_ID, res);

    expect(res._statusCode).toBe(404);
    expect(mockFeeAudit.create).not.toHaveBeenCalled();
  });

  test("rolls the deletion back and refuses when the audit row cannot be written", async () => {
    stubFindById(liveFee());
    mockFees.findOneAndUpdate.mockResolvedValue(liveFee({ isDeleted: true }));
    mockFeeAudit.create.mockRejectedValue(new Error("write conflict"));

    const res = makeRes();
    await expect(deleteFeeService(FEE_ID, ADMIN_ID, res)).rejects.toThrow(
      /was NOT deleted \(audit log write failed\)/
    );

    // Rollback: the record is live again and the delete bookkeeping is cleared.
    expect(mockFees.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockFees.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: FEE_ID, isDeleted: true });
    expect(update.isDeleted).toBe(false);
    expect(update.$unset).toMatchObject({ deletedAt: "", deletedBy: "" });

    // No success response was ever sent.
    expect(res._statusCode).toBeUndefined();
  });

  test("refuses an unattributed deletion (no actor) and leaves the record live", async () => {
    stubFindById(liveFee());
    mockFees.findOneAndUpdate.mockResolvedValue(liveFee({ isDeleted: true }));

    const res = makeRes();
    await expect(deleteFeeService(FEE_ID, undefined, res)).rejects.toThrow(
      /refusing unattributed fee change/
    );

    expect(mockFeeAudit.create).not.toHaveBeenCalled();
    expect(mockFees.updateOne).toHaveBeenCalledTimes(1); // rolled back
    expect(res._statusCode).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. updateFeeService — audited edits, deleted records untouchable
// ═════════════════════════════════════════════════════════════════════════════

describe("updateFeeService — audited edits", () => {
  function stubUpdate(before, after) {
    stubFindById(before);
    mockFees.findByIdAndUpdate.mockResolvedValue({
      ...after,
      toObject: () => after,
    });
  }

  test("records a field-level diff with the actor who made the change", async () => {
    stubUpdate(liveFee(), liveFee({ amount: 4000 }));

    const res = makeRes();
    await updateFeeService(FEE_ID, { amount: 4000 }, ADMIN_ID, res);

    expect(res._statusCode).toBe(200);
    expect(mockFeeAudit.create).toHaveBeenCalledTimes(1);
    const entry = mockFeeAudit.create.mock.calls[0][0];
    expect(entry.action).toBe("update");
    expect(entry.actor).toBe(ADMIN_ID);
    expect(entry.changes).toEqual({ amount: { from: 5000, to: 4000 } });
  });

  test("writes no audit row when nothing actually changed", async () => {
    stubUpdate(liveFee(), liveFee());

    await updateFeeService(FEE_ID, { amount: 5000 }, ADMIN_ID, makeRes());

    expect(mockFeeAudit.create).not.toHaveBeenCalled();
  });

  test("404s for an invisible (soft-deleted) record before any write happens", async () => {
    stubFindById(null);

    const res = makeRes();
    await updateFeeService(FEE_ID, { amount: 1 }, ADMIN_ID, res);

    expect(res._statusCode).toBe(404);
    expect(mockFees.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(mockFeeAudit.create).not.toHaveBeenCalled();
  });

  test("ignores fields outside the allow-list (student/recordedBy cannot be edited)", async () => {
    stubUpdate(liveFee(), liveFee({ notes: "corrected" }));

    await updateFeeService(
      FEE_ID,
      { notes: "corrected", student: "someone-else", recordedBy: "attacker" },
      ADMIN_ID,
      makeRes()
    );

    const applied = mockFees.findByIdAndUpdate.mock.calls[0][1];
    expect(applied).toEqual({ notes: "corrected" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Fee audit read path (GET /fees/audit, admin-only per the router)
// ═════════════════════════════════════════════════════════════════════════════

describe("getFeeAuditService", () => {
  test("queries the audit log newest-first and honours actor/action/fee filters", async () => {
    mockPaginate.mockResolvedValue({ data: [], pagination: { total: 0 } });

    const res = makeRes();
    await getFeeAuditService(
      { actor: ADMIN_ID, action: "delete", fee: FEE_ID, page: "2", limit: "10" },
      res
    );

    const [model, filters, options] = mockPaginate.mock.calls[0];
    expect(model).toBe(mockFeeAudit);
    expect(filters).toEqual({ actor: ADMIN_ID, action: "delete", fee: FEE_ID });
    expect(options.sort).toBe("-createdAt");
    expect(options.page).toBe("2");
    expect(res._statusCode).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Schema-level scoping — the archived row stays archived
// ═════════════════════════════════════════════════════════════════════════════

describe("Fees schema — soft-deleted rows are scoped out of every operation", () => {
  // Each of these names is what mongoose actually fires for the corresponding
  // driver call, so the list doubles as proof the regex matchers were expanded
  // over the whole operation family (including the findOneAnd*/update families).
  const SCOPED_OPS = [
    "find", // Fees.find(...) — lists, dashboards, parent portal, reports
    "findOne", // Fees.findOne(...) and findById(...)
    "findOneAndUpdate", // the soft-delete flag write + edits
    "findOneAndDelete",
    "findOneAndReplace",
    "countDocuments", // paginate() totals
    "distinct",
    "updateOne",
    "updateMany",
  ];

  test.each(SCOPED_OPS)("%s gets the isDeleted guard appended", (op) => {
    const filter = runHook(op, fakeQuery({ student: STUDENT_ID }));
    expect(filter).toMatchObject({ isDeleted: { $ne: true } });
  });

  test("an explicit isDeleted condition is respected (audit/recovery tooling)", () => {
    const filter = runHook("find", fakeQuery({ isDeleted: true }));
    expect(filter).toEqual({ isDeleted: true });
  });

  test("the includeDeleted option bypasses the guard", () => {
    const filter = runHook("find", fakeQuery({ student: STUDENT_ID }, { includeDeleted: true }));
    expect(filter).toEqual({ student: STUDENT_ID });
  });

  test("aggregate() gets a leading $match so fee totals ignore deleted rows", () => {
    const pipeline = [{ $group: { _id: null, total: { $sum: "$amount" } } }];
    const ctx = { options: {}, pipeline: () => pipeline };

    hookFor("aggregate").call(ctx, (err) => {
      if (err) throw err;
    });

    expect(ctx.pipeline()[0]).toEqual({ $match: { isDeleted: { $ne: true } } });
    expect(ctx.pipeline()).toHaveLength(2);
  });

  test("aggregate() does not double-scope when the pipeline already filters isDeleted", () => {
    const pipeline = [{ $match: { isDeleted: true } }];
    const ctx = { options: {}, pipeline: () => pipeline };

    hookFor("aggregate").call(ctx, (err) => {
      if (err) throw err;
    });

    expect(ctx.pipeline()).toEqual([{ $match: { isDeleted: true } }]);
  });

  test("deleteOne/deleteMany are refused — a fee may not be hard-deleted by accident", () => {
    for (const op of ["deleteOne", "deleteMany"]) {
      expect(() => runHook(op, fakeQuery({ student: STUDENT_ID }))).toThrow(
        /never hard-deleted/
      );
    }
  });

  test("a deliberate purge must opt in explicitly", () => {
    const filter = fakeQuery({ student: STUDENT_ID }, { allowHardDelete: true });
    expect(() => runHook("deleteMany", filter)).not.toThrow();
  });
});

