const mongoose = require("mongoose");

// Expense entry — Phase 3 (flexible finance). NEW collection, independent of
// attendance/salary/fees. One row per recorded expense.
//
// totalAmount is ALWAYS derived server-side as round2(quantity × unitRate); a
// client-supplied total is never trusted (same fail-closed rule as salary runs).
// `date` follows the attendance/salary convention: server-LOCAL midnight, and
// date-range filters are inclusive on both ends (see the entry service).
//
// Entries are now editable and soft-deletable (admin only), mirroring the Fees
// pattern: "deleting" only flags the row and hides it from every normal read,
// and the general audit trail records who edited/deleted it and when. No
// expense row is ever hard-removed (see the hard-delete guard below).
const expenseEntrySchema = new mongoose.Schema(
  {
    expenseHead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExpenseHead",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    itemName: {
      type: String,
      required: true,
      trim: true,
    },
    // Decimal quantities are allowed (e.g. 2.5 units); must be strictly positive.
    quantity: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => Number.isFinite(v) && v > 0,
        message: "Quantity must be greater than 0",
      },
    },
    // Decimal rates are allowed (e.g. Rs 45.50); zero is permitted, negative is not.
    unitRate: {
      type: Number,
      required: true,
      min: [0, "Unit rate cannot be negative"],
    },
    // Auto-calculated = round2(quantity × unitRate). Never accepted from the client.
    totalAmount: {
      type: Number,
      required: true,
      min: [0, "Total amount cannot be negative"],
    },
    notes: {
      type: String,
      default: "",
    },
    // Admin who recorded this entry (Admin collection).
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    // ── Soft delete (mirrors models/Fees/fees.model.js) ──────────────────
    // A financial record is never hard-removed. "Deleting" an expense entry
    // flags it and hides it from every normal read; the who/when/what lives
    // in the general audit trail. Pass `includeDeleted: true` (or set an
    // explicit `isDeleted` condition) to read them again — audit tooling only.
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
  },
  { timestamps: true }
);

// Date-wise log + per-head date-range history (Phase 4 collections-vs-expenses).
expenseEntrySchema.index({ date: 1 });
expenseEntrySchema.index({ expenseHead: 1, date: 1 });

// ── Read-scope guard ──────────────────────────────────────────────
// Applied at the schema level so a soft-deleted entry cannot resurface through
// a read path a future change forgets to filter — the history list, the running
// total aggregate, the finance reports and the net summary are all covered.
const NOT_DELETED = { isDeleted: { $ne: true } };

function alreadyScopesDeleted(filter) {
  return !!(filter && Object.prototype.hasOwnProperty.call(filter, "isDeleted"));
}

function isSelfScoped(query) {
  const options = (query.getOptions && query.getOptions()) || {};
  return options.includeDeleted === true || alreadyScopesDeleted(query.getFilter());
}

expenseEntrySchema.pre(/^find/, function (next) {
  if (!isSelfScoped(this)) this.where(NOT_DELETED);
  next();
});

expenseEntrySchema.pre(["countDocuments", "distinct"], function (next) {
  if (!isSelfScoped(this)) this.where(NOT_DELETED);
  next();
});

// Bulk updates must never mutate a soft-deleted row (a stale id can't edit or
// revive it).
expenseEntrySchema.pre(/^(updateOne|updateMany)$/, function (next) {
  if (!isSelfScoped(this)) this.where(NOT_DELETED);
  next();
});

// Aggregations (running totals, finance reports, net summary) — leading $match.
// NOTE: aggregate objects carry their options on `this.options` (no getOptions()).
expenseEntrySchema.pre("aggregate", function (next) {
  const options = this.options || {};
  if (options.includeDeleted !== true) {
    const pipeline = this.pipeline() || [];
    const scopes = pipeline.some(
      (stage) =>
        stage && stage.$match && Object.prototype.hasOwnProperty.call(stage.$match, "isDeleted")
    );
    if (!scopes) pipeline.unshift({ $match: NOT_DELETED });
  }
  next();
});

// ── Hard-delete guard ───────────────────────────────────────────────
// Soft delete is the only deletion path in the app; a physically removed row
// would also destroy the document the audit trail points at.
expenseEntrySchema.pre(/^(deleteOne|deleteMany)$/, function (next) {
  const options = (this.getOptions && this.getOptions()) || {};
  if (options.allowHardDelete !== true) {
    return next(
      new Error(
        "Expense entries are never hard-deleted — use deleteExpenseEntryService (soft delete + audit). " +
          "Pass { allowHardDelete: true } for a deliberate purge."
      )
    );
  }
  next();
});

module.exports = mongoose.model("ExpenseEntry", expenseEntrySchema);
