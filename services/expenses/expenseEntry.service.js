const responseStatus = require("../../handlers/responseStatus.handler");
const mongoose = require("mongoose");
const ExpenseHead = require("../../models/Expenses/expenseHead.model");
const ExpenseEntry = require("../../models/Expenses/expenseEntry.model");
const { paginate } = require("../../utils/paginate");
const { round2, parseDayStart } = require("../../utils/teacherSalaryCalc");
const { dayRangeFilter } = require("../../utils/dateRange");
const { localDateKey } = require("../../utils/localDateKey");
const { recordAudit, formatDay, formatMoney, changedFields } = require("../audit/auditLog.service");

// Inclusive range upper bound comes from the shared local-day helper
// (utils/dateRange): [from midnight, to midnight + 1 day) — same
// local-midnight convention as the salary/attendance period queries.

// ---- Create an expense entry (admin only) ----
// Fail-closed: every field is validated BEFORE any write, and totalAmount is
// recomputed server-side as round2(quantity × unitRate) — a client-supplied total
// is never trusted (same rule as salary runs). The head must exist AND be active.
exports.createExpenseEntryService = async (data, adminId, res) => {
  const payload = data || {};

  if (!mongoose.Types.ObjectId.isValid(String(payload.expenseHead))) {
    return responseStatus(res, 400, "failed", "Invalid expense head");
  }
  const head = await ExpenseHead.findById(payload.expenseHead).select("name isActive").lean();
  if (!head) return responseStatus(res, 400, "failed", "Expense head not found");
  if (!head.isActive) {
    return responseStatus(res, 400, "failed", "Expense head is inactive — reactivate it or pick another head");
  }

  const date = parseDayStart(payload.date);
  if (!date) return responseStatus(res, 400, "failed", "Invalid date — expected YYYY-MM-DD");

  const itemName = (payload.itemName ? String(payload.itemName) : "").trim();
  if (!itemName) return responseStatus(res, 400, "failed", "Item name is required");

  // Decimals are allowed (2.5 units, Rs 45.50). Quantity must be > 0; rate >= 0.
  const quantity = Number(payload.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return responseStatus(res, 400, "failed", "Quantity must be a number greater than 0");
  }
  const unitRate = Number(payload.unitRate);
  if (!Number.isFinite(unitRate) || unitRate < 0) {
    return responseStatus(res, 400, "failed", "Unit rate must be 0 or more");
  }

  const totalAmount = round2(quantity * unitRate);

  const entry = await ExpenseEntry.create({
    expenseHead: head._id,
    date,
    itemName,
    quantity,
    unitRate,
    totalAmount,
    notes: payload.notes ? String(payload.notes) : "",
    createdBy: adminId,
  });
  // Audit trail (fail-open, fire-and-forget — never blocks the save).
  recordAudit({
    userId: adminId,
    actionType: "create",
    entityType: "expense_entry",
    entityId: entry._id,
    summary: `Recorded expense "${itemName}" under ${head.name} — ${formatMoney(totalAmount)} on ${formatDay(date)}`,
    afterSnapshot: {
      expenseHead: head.name,
      date: localDateKey(date),
      itemName,
      quantity,
      unitRate,
      totalAmount,
    },
  });
  return responseStatus(res, 201, "success", entry);
};

// ---- Edit an expense entry (admin only) ----
// Mirrors create exactly: the head must exist AND be active, quantity > 0,
// unitRate >= 0, and totalAmount is ALWAYS recomputed server-side as
// round2(quantity × unitRate) — a client total is never trusted (no manual
// override, same fail-closed rule as create). ALL fields are editable:
// expenseHead, date, itemName, quantity, unitRate, totalAmount (derived) and
// notes. Fail-closed — nothing is written until every field validates. A
// soft-deleted row is invisible to findById, so a stale id 404s rather than
// silently editing/reviving it.
exports.updateExpenseEntryService = async (entryId, data, adminId, res) => {
  const payload = data || {};

  if (!mongoose.Types.ObjectId.isValid(String(entryId))) {
    return responseStatus(res, 400, "failed", "Invalid expense entry id");
  }
  const before = await ExpenseEntry.findById(entryId).populate("expenseHead", "name").lean();
  if (!before) return responseStatus(res, 404, "failed", "Expense entry not found");

  if (!mongoose.Types.ObjectId.isValid(String(payload.expenseHead))) {
    return responseStatus(res, 400, "failed", "Invalid expense head");
  }
  const head = await ExpenseHead.findById(payload.expenseHead).select("name isActive").lean();
  if (!head) return responseStatus(res, 400, "failed", "Expense head not found");
  if (!head.isActive) {
    return responseStatus(res, 400, "failed", "Expense head is inactive — reactivate it or pick another head");
  }

  const date = parseDayStart(payload.date);
  if (!date) return responseStatus(res, 400, "failed", "Invalid date — expected YYYY-MM-DD");

  const itemName = (payload.itemName ? String(payload.itemName) : "").trim();
  if (!itemName) return responseStatus(res, 400, "failed", "Item name is required");

  const quantity = Number(payload.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return responseStatus(res, 400, "failed", "Quantity must be a number greater than 0");
  }
  const unitRate = Number(payload.unitRate);
  if (!Number.isFinite(unitRate) || unitRate < 0) {
    return responseStatus(res, 400, "failed", "Unit rate must be 0 or more");
  }
  const totalAmount = round2(quantity * unitRate);
  const notes = payload.notes ? String(payload.notes) : "";

  const entry = await ExpenseEntry.findByIdAndUpdate(
    entryId,
    { $set: { expenseHead: head._id, date, itemName, quantity, unitRate, totalAmount, notes } },
    { new: true }
  );
  if (!entry) return responseStatus(res, 404, "failed", "Expense entry not found");

  const snap = (o) => ({
    expenseHead: o.expenseHead,
    date: o.date,
    itemName: o.itemName,
    quantity: o.quantity,
    unitRate: o.unitRate,
    totalAmount: o.totalAmount,
    notes: o.notes,
  });
  const beforeSnap = snap({
    expenseHead: before.expenseHead ? before.expenseHead.name : "—",
    date: before.date,
    itemName: before.itemName,
    quantity: before.quantity,
    unitRate: before.unitRate,
    totalAmount: before.totalAmount,
    notes: before.notes,
  });
  const afterSnap = snap({
    expenseHead: head.name,
    date,
    itemName,
    quantity,
    unitRate,
    totalAmount,
    notes,
  });
  const diff = changedFields(beforeSnap, afterSnap, [
    "expenseHead",
    "date",
    "itemName",
    "quantity",
    "unitRate",
    "totalAmount",
    "notes",
  ]);
  if (diff) {
    recordAudit({
      userId: adminId,
      actionType: "update",
      entityType: "expense_entry",
      entityId: entry._id,
      summary: `Edited expense "${itemName}" under ${head.name} — ${formatMoney(totalAmount)} on ${formatDay(date)}`,
      beforeSnapshot: diff.before,
      afterSnapshot: diff.after,
    });
  }
  return responseStatus(res, 200, "success", entry);
};

// ---- Soft-delete an expense entry (admin only) ----
// The row is flagged isDeleted and hidden from every normal read by the schema
// scoping in models/Expenses/expenseEntry.model.js; nothing is ever
// hard-removed. The action + a snapshot of what was removed go to the general
// audit trail.
exports.deleteExpenseEntryService = async (entryId, adminId, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(entryId))) {
    return responseStatus(res, 400, "failed", "Invalid expense entry id");
  }
  const before = await ExpenseEntry.findById(entryId).populate("expenseHead", "name").lean();
  if (!before) return responseStatus(res, 404, "failed", "Expense entry not found");

  const deletedAt = new Date();
  const entry = await ExpenseEntry.findOneAndUpdate(
    { _id: entryId },
    { isDeleted: true, deletedAt, deletedBy: adminId },
    { new: true }
  );
  if (!entry) return responseStatus(res, 404, "failed", "Expense entry not found");

  recordAudit({
    userId: adminId,
    actionType: "delete",
    entityType: "expense_entry",
    entityId: entry._id,
    summary: `Deleted expense "${before.itemName}" under ${
      before.expenseHead ? before.expenseHead.name : "—"
    } — ${formatMoney(before.totalAmount)} on ${formatDay(before.date)}`,
    beforeSnapshot: {
      expenseHead: before.expenseHead ? before.expenseHead.name : "—",
      date: before.date,
      itemName: before.itemName,
      quantity: before.quantity,
      unitRate: before.unitRate,
      totalAmount: before.totalAmount,
      notes: before.notes,
    },
  });
  return responseStatus(res, 200, "success", "Expense entry deleted");
};

// ---- Expense history (admin only) ----
// Date-wise log, filterable by head and an inclusive local-calendar date range.
// The running total sums totalAmount across the FULL filtered set (aggregate),
// independent of the current page — so it stays correct while paginating.
exports.getExpenseEntriesService = async (filters = {}, res) => {
  const match = {};

  if (filters.expenseHead) {
    if (!mongoose.Types.ObjectId.isValid(String(filters.expenseHead))) {
      return responseStatus(res, 400, "failed", "Invalid expense head");
    }
    // Cast explicitly: aggregation $match does NOT auto-cast hex strings.
    match.expenseHead = new mongoose.Types.ObjectId(String(filters.expenseHead));
  }

  const from = filters.from ? parseDayStart(filters.from) : null;
  const to = filters.to ? parseDayStart(filters.to) : null;
  if (filters.from && !from) return responseStatus(res, 400, "failed", "Invalid from date — expected YYYY-MM-DD");
  if (filters.to && !to) return responseStatus(res, 400, "failed", "Invalid to date — expected YYYY-MM-DD");
  if (from && to && from > to) return responseStatus(res, 400, "failed", "From date must not be after to date");
  if (from || to) {
    match.date = dayRangeFilter(filters.from, filters.to);
  }

  const { data, pagination } = await paginate(ExpenseEntry, match, {
    page: filters.page,
    limit: filters.limit,
    sort: "-date -createdAt",
    populate: [
      { path: "expenseHead", select: "name isActive" },
      { path: "createdBy", select: "name" },
    ],
  });

  // Running total over the full filtered set (not just this page).
  const [agg] = await ExpenseEntry.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
  ]);

  return responseStatus(res, 200, "success", {
    entries: data,
    pagination,
    runningTotal: round2(agg ? agg.total : 0),
    count: agg ? agg.count : 0,
  });
};
