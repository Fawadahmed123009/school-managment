const responseStatus = require("../../handlers/responseStatus.handler");
const mongoose = require("mongoose");
const IncomeHead = require("../../models/Income/incomeHead.model");
const IncomeEntry = require("../../models/Income/incomeEntry.model");
const { paginate } = require("../../utils/paginate");
const { round2, parseDayStart } = require("../../utils/teacherSalaryCalc");
const { dayRangeFilter } = require("../../utils/dateRange");
const { localDateKey } = require("../../utils/localDateKey");
const { recordAudit, formatDay, formatMoney, changedFields } = require("../audit/auditLog.service");

// Inclusive range upper bound comes from the shared local-day helper
// (utils/dateRange): [from midnight, to midnight + 1 day) — same
// local-midnight convention as the salary/attendance/expense period queries.

// A field counts as "provided" only when it is a non-empty value. Form bodies
// arrive as strings, so an untouched input is "" (not provided). The mode is
// derived from field presence — never from a client "mode" flag (fail-closed).
const isPresent = (v) => v !== undefined && v !== null && String(v).trim() !== "";

// ---- Create an income entry (admin only) ----
// Fail-closed: every field is validated BEFORE any write. Two modes:
//   • quantity + unitRate both given → totalAmount = round2(quantity × unitRate)
//     (a client-supplied total is ignored, same rule as expenses/salary).
//   • neither given → admin enters totalAmount directly (e.g. a lump donation),
//     validated as a finite number > 0 and normalised with round2.
// Giving only ONE of quantity/unitRate is ambiguous → 400. The head must exist
// AND be active.
exports.createIncomeEntryService = async (data, adminId, res) => {
  const payload = data || {};

  if (!mongoose.Types.ObjectId.isValid(String(payload.incomeHead))) {
    return responseStatus(res, 400, "failed", "Invalid income head");
  }
  const head = await IncomeHead.findById(payload.incomeHead).select("name isActive").lean();
  if (!head) return responseStatus(res, 400, "failed", "Income head not found");
  if (!head.isActive) {
    return responseStatus(res, 400, "failed", "Income head is inactive — reactivate it or pick another head");
  }

  const date = parseDayStart(payload.date);
  if (!date) return responseStatus(res, 400, "failed", "Invalid date — expected YYYY-MM-DD");

  const description = (payload.description ? String(payload.description) : "").trim();
  if (!description) return responseStatus(res, 400, "failed", "Description is required");

  const hasQty = isPresent(payload.quantity);
  const hasRate = isPresent(payload.unitRate);
  if (hasQty !== hasRate) {
    return responseStatus(
      res,
      400,
      "failed",
      "Provide both quantity and unit rate, or enter a total amount directly"
    );
  }

  const doc = {
    incomeHead: head._id,
    date,
    description,
    notes: payload.notes ? String(payload.notes) : "",
    createdBy: adminId,
  };

  if (hasQty && hasRate) {
    // Quantity mode — decimals allowed (2.5 units, Rs 45.50). Quantity > 0;
    // rate >= 0. totalAmount is recomputed; any client total is never trusted.
    const quantity = Number(payload.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return responseStatus(res, 400, "failed", "Quantity must be a number greater than 0");
    }
    const unitRate = Number(payload.unitRate);
    if (!Number.isFinite(unitRate) || unitRate < 0) {
      return responseStatus(res, 400, "failed", "Unit rate must be 0 or more");
    }
    doc.quantity = quantity;
    doc.unitRate = unitRate;
    doc.totalAmount = round2(quantity * unitRate);
  } else {
    // Direct mode — the admin-entered total is the source, validated here.
    const totalAmount = Number(payload.totalAmount);
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return responseStatus(res, 400, "failed", "Total amount must be a number greater than 0");
    }
    doc.totalAmount = round2(totalAmount);
  }

  const entry = await IncomeEntry.create(doc);
  // Audit trail (fail-open, fire-and-forget — never blocks the save).
  const afterSnapshot = {
    incomeHead: head.name,
    date: localDateKey(date),
    description,
    totalAmount: doc.totalAmount,
  };
  if (hasQty && hasRate) {
    afterSnapshot.quantity = doc.quantity;
    afterSnapshot.unitRate = doc.unitRate;
  }
  recordAudit({
    userId: adminId,
    actionType: "create",
    entityType: "income_entry",
    entityId: entry._id,
    summary: `Recorded income "${description}" under ${head.name} — ${formatMoney(doc.totalAmount)} on ${formatDay(date)}`,
    afterSnapshot,
  });
  return responseStatus(res, 201, "success", entry);
};

// ---- Edit an income entry (admin only) ----
// Mirrors create exactly: the mode is derived from WHICH fields are present
// (never a client flag), totalAmount is recomputed in quantity mode and
// validated/normalised in direct mode, the head must exist AND be active. ALL
// fields are editable: incomeHead, date, description, quantity, unitRate,
// totalAmount (and notes). Fail-closed — nothing is written until every field
// validates. A soft-deleted row is invisible to findById, so a stale id 404s
// rather than silently editing/reviving it.
exports.updateIncomeEntryService = async (entryId, data, adminId, res) => {
  const payload = data || {};

  if (!mongoose.Types.ObjectId.isValid(String(entryId))) {
    return responseStatus(res, 400, "failed", "Invalid income entry id");
  }
  const before = await IncomeEntry.findById(entryId).populate("incomeHead", "name").lean();
  if (!before) return responseStatus(res, 404, "failed", "Income entry not found");

  if (!mongoose.Types.ObjectId.isValid(String(payload.incomeHead))) {
    return responseStatus(res, 400, "failed", "Invalid income head");
  }
  const head = await IncomeHead.findById(payload.incomeHead).select("name isActive").lean();
  if (!head) return responseStatus(res, 400, "failed", "Income head not found");
  if (!head.isActive) {
    return responseStatus(res, 400, "failed", "Income head is inactive — reactivate it or pick another head");
  }

  const date = parseDayStart(payload.date);
  if (!date) return responseStatus(res, 400, "failed", "Invalid date — expected YYYY-MM-DD");

  const description = (payload.description ? String(payload.description) : "").trim();
  if (!description) return responseStatus(res, 400, "failed", "Description is required");

  const hasQty = isPresent(payload.quantity);
  const hasRate = isPresent(payload.unitRate);
  if (hasQty !== hasRate) {
    return responseStatus(
      res,
      400,
      "failed",
      "Provide both quantity and unit rate, or enter a total amount directly"
    );
  }

  const notes = payload.notes ? String(payload.notes) : "";
  const update = { $set: { incomeHead: head._id, date, description, notes } };
  let quantity, unitRate, totalAmount;

  if (hasQty && hasRate) {
    // Quantity mode — total recomputed; switching to it clears any prior direct total.
    quantity = Number(payload.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return responseStatus(res, 400, "failed", "Quantity must be a number greater than 0");
    }
    unitRate = Number(payload.unitRate);
    if (!Number.isFinite(unitRate) || unitRate < 0) {
      return responseStatus(res, 400, "failed", "Unit rate must be 0 or more");
    }
    totalAmount = round2(quantity * unitRate);
    update.$set.quantity = quantity;
    update.$set.unitRate = unitRate;
    update.$set.totalAmount = totalAmount;
  } else {
    // Direct mode — the admin-entered total is the source; quantity/unitRate unset.
    totalAmount = Number(payload.totalAmount);
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      return responseStatus(res, 400, "failed", "Total amount must be a number greater than 0");
    }
    totalAmount = round2(totalAmount);
    update.$set.totalAmount = totalAmount;
    update.$unset = { quantity: "", unitRate: "" };
  }

  const entry = await IncomeEntry.findByIdAndUpdate(entryId, update, { new: true });
  if (!entry) return responseStatus(res, 404, "failed", "Income entry not found");

  // Audit trail (fail-open). Only the changed fields are recorded so the
  // viewer shows a clean before/after.
  const snap = (o) => ({
    incomeHead: o.incomeHead,
    date: o.date,
    description: o.description,
    quantity: o.quantity,
    unitRate: o.unitRate,
    totalAmount: o.totalAmount,
    notes: o.notes,
  });
  const beforeSnap = snap({
    incomeHead: before.incomeHead ? before.incomeHead.name : "—",
    date: before.date,
    description: before.description,
    quantity: before.quantity,
    unitRate: before.unitRate,
    totalAmount: before.totalAmount,
    notes: before.notes,
  });
  const afterSnap = snap({
    incomeHead: head.name,
    date,
    description,
    quantity: hasQty ? quantity : undefined,
    unitRate: hasRate ? unitRate : undefined,
    totalAmount,
    notes,
  });
  const diff = changedFields(beforeSnap, afterSnap, [
    "incomeHead",
    "date",
    "description",
    "quantity",
    "unitRate",
    "totalAmount",
    "notes",
  ]);
  if (diff) {
    recordAudit({
      userId: adminId,
      actionType: "update",
      entityType: "income_entry",
      entityId: entry._id,
      summary: `Edited income "${description}" under ${head.name} — ${formatMoney(totalAmount)} on ${formatDay(date)}`,
      beforeSnapshot: diff.before,
      afterSnapshot: diff.after,
    });
  }
  return responseStatus(res, 200, "success", entry);
};

// ---- Soft-delete an income entry (admin only) ----
// The row is flagged isDeleted and hidden from every normal read by the schema
// scoping in models/Income/incomeEntry.model.js; nothing is ever hard-removed.
// The action + a snapshot of what was removed go to the general audit trail.
exports.deleteIncomeEntryService = async (entryId, adminId, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(entryId))) {
    return responseStatus(res, 400, "failed", "Invalid income entry id");
  }
  const before = await IncomeEntry.findById(entryId).populate("incomeHead", "name").lean();
  if (!before) return responseStatus(res, 404, "failed", "Income entry not found");

  const deletedAt = new Date();
  const entry = await IncomeEntry.findOneAndUpdate(
    { _id: entryId },
    { isDeleted: true, deletedAt, deletedBy: adminId },
    { new: true }
  );
  if (!entry) return responseStatus(res, 404, "failed", "Income entry not found");

  recordAudit({
    userId: adminId,
    actionType: "delete",
    entityType: "income_entry",
    entityId: entry._id,
    summary: `Deleted income "${before.description}" under ${
      before.incomeHead ? before.incomeHead.name : "—"
    } — ${formatMoney(before.totalAmount)} on ${formatDay(before.date)}`,
    beforeSnapshot: {
      incomeHead: before.incomeHead ? before.incomeHead.name : "—",
      date: before.date,
      description: before.description,
      quantity: before.quantity,
      unitRate: before.unitRate,
      totalAmount: before.totalAmount,
      notes: before.notes,
    },
  });
  return responseStatus(res, 200, "success", "Income entry deleted");
};

// ---- Income history (admin only) ----
// Date-wise log, filterable by head and an inclusive local-calendar date range.
// The running total sums totalAmount across the FULL filtered set (aggregate),
// independent of the current page — so it stays correct while paginating.
exports.getIncomeEntriesService = async (filters = {}, res) => {
  const match = {};

  if (filters.incomeHead) {
    if (!mongoose.Types.ObjectId.isValid(String(filters.incomeHead))) {
      return responseStatus(res, 400, "failed", "Invalid income head");
    }
    // Cast explicitly: aggregation $match does NOT auto-cast hex strings.
    match.incomeHead = new mongoose.Types.ObjectId(String(filters.incomeHead));
  }

  const from = filters.from ? parseDayStart(filters.from) : null;
  const to = filters.to ? parseDayStart(filters.to) : null;
  if (filters.from && !from) return responseStatus(res, 400, "failed", "Invalid from date — expected YYYY-MM-DD");
  if (filters.to && !to) return responseStatus(res, 400, "failed", "Invalid to date — expected YYYY-MM-DD");
  if (from && to && from > to) return responseStatus(res, 400, "failed", "From date must not be after to date");
  if (from || to) {
    match.date = dayRangeFilter(filters.from, filters.to);
  }

  const { data, pagination } = await paginate(IncomeEntry, match, {
    page: filters.page,
    limit: filters.limit,
    sort: "-date -createdAt",
    populate: [
      { path: "incomeHead", select: "name isActive" },
      { path: "createdBy", select: "name" },
    ],
  });

  // Running total over the full filtered set (not just this page).
  const [agg] = await IncomeEntry.aggregate([
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