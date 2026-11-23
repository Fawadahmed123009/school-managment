const mongoose = require("mongoose");

// Income entry — flexible ad-hoc income (parallel to Phase 3 Expenses). NEW
// collection, independent of attendance/salary/fees/expenses. One row per
// recorded income event (e.g. notes sold to a few students, a lump donation).
//
// Unlike an expense (always quantity × unitRate), income has TWO modes:
//   • quantity-based: quantity + unitRate given → totalAmount is derived
//     server-side as round2(quantity × unitRate); a client total is ignored.
//   • direct: quantity/rate omitted → admin enters totalAmount directly
//     (e.g. a donation), validated server-side (finite, > 0, round2).
// The service decides the mode from which fields are present (fail-closed);
// quantity/unitRate are therefore OPTIONAL here and only stored when given.
//
// `date` follows the attendance/salary/expense convention: server-LOCAL
// midnight, and date-range filters are inclusive on both ends (entry service).
//
// Entries are now editable and soft-deletable (admin only), mirroring the Fees
// pattern: "deleting" only flags the row and hides it from every normal read,
// and the general audit trail records who edited/deleted it and when. No income
// row is ever hard-removed (see the hard-delete guard below).
const incomeEntrySchema = new mongoose.Schema(
  {
    incomeHead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IncomeHead",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    // Optional — only present for quantity-based income. Decimals allowed
    // (e.g. 2.5 units); must be strictly positive when set.
    quantity: {
      type: Number,
      validate: {
        validator: (v) => Number.isFinite(v) && v > 0,
        message: "Quantity must be greater than 0",
      },
    },
    // Optional — only present for quantity-based income. Decimals allowed
    // (e.g. Rs 45.50); zero permitted, negative is not.
    unitRate: {
      type: Number,
      min: [0, "Unit rate cannot be negative"],
    },
    // round2(quantity × unitRate) in quantity mode, or the admin-entered total
    // in direct mode. Always validated/normalised server-side.
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
    // A financial record is never hard-removed. "Deleting" an income entry
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

// Date-wise log + per-head date-range history, and the net-summary aggregate.
incomeEntrySchema.index({ date: 1 });
incomeEntrySchema.index({ incomeHead: 1, date: 1 });

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

incomeEntrySchema.pre(/^find/, function (next) {
  if (!isSelfScoped(this)) this.where(NOT_DELETED);
  next();
});

incomeEntrySchema.pre(["countDocuments", "distinct"], function (next) {
  if (!isSelfScoped(this)) this.where(NOT_DELETED);
  next();
});

// Bulk updates must never mutate a soft-deleted row (a stale id can't edit or
// revive it).
incomeEntrySchema.pre(/^(updateOne|updateMany)$/, function (next) {
  if (!isSelfScoped(this)) this.where(NOT_DELETED);
  next();
});

// Aggregations (running totals, finance reports, net summary) — leading $match.
// NOTE: aggregate objects carry their options on `this.options` (no getOptions()).
incomeEntrySchema.pre("aggregate", function (next) {
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
incomeEntrySchema.pre(/^(deleteOne|deleteMany)$/, function (next) {
  const options = (this.getOptions && this.getOptions()) || {};
  if (options.allowHardDelete !== true) {
    return next(
      new Error(
        "Income entries are never hard-deleted — use deleteIncomeEntryService (soft delete + audit). " +
          "Pass { allowHardDelete: true } for a deliberate purge."
      )
    );
  }
  next();
});

module.exports = mongoose.model("IncomeEntry", incomeEntrySchema);