const mongoose = require("mongoose");

const feesSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },
    academicYear: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AcademicYear",
    },
    academicTerm: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AcademicTerm",
    },
    feeType: {
      type: String,
      default: "tuition",
    },
    feeHead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FeeHead",
    },
    amount: {
      type: Number,
      required: true,
      min: [0, "Amount cannot be negative"],
      validate: {
        validator: (v) => v >= 0,
        message: "Fee amount cannot be negative",
      },
    },
    status: {
      type: String,
      enum: ["pending", "paid", "partial"],
      default: "pending",
    },
    datePaid: {
      type: Date,
    },
    source: {
      type: String,
      enum: ["manual", "ocr"],
      default: "manual",
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    billingMonth: {
      type: String,
      // format "YYYY-MM", e.g. "2026-09"
      match: [/^\d{4}-\d{2}$/, "billingMonth must be in YYYY-MM format"],
    },
    notes: {
      type: String,
    },
    // ── Soft delete (C2) ───────────────────────────────────────────
    // A financial record is never hard-removed. "Deleting" a fee flags it and
    // hides it from every normal read, while the fee audit log keeps the
    // who/when/what. Pass `includeDeleted: true` as a query option (or set an
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

// ── Read-scope guard ──────────────────────────────────────────────
// Applied at the schema level on purpose: fee records are read from ~25
// places (fee list, dashboards, parent portal, student analysis, collection
// and defaulter reports, OCR matching, monthly generation, …). Filtering here
// means a soft-deleted record cannot resurface through a read path that a
// future change forgets to filter.
const NOT_DELETED = { isDeleted: { $ne: true } };

function alreadyScopesDeleted(filter) {
  return !!(filter && Object.prototype.hasOwnProperty.call(filter, "isDeleted"));
}

// True when a query already says what it wants about isDeleted, either
// explicitly in its filter or via the `includeDeleted` option.
function isSelfScoped(query) {
  const options = (query.getOptions && query.getOptions()) || {};
  return options.includeDeleted === true || alreadyScopesDeleted(query.getFilter());
}

// find / findOne / findById, plus the findOneAnd* family (they all start with
// "find", so the update/delete hooks below deliberately do not repeat them).
feesSchema.pre(/^find/, function (next) {
  if (!isSelfScoped(this)) this.where(NOT_DELETED);
  next();
});

// countDocuments / distinct
feesSchema.pre(["countDocuments", "distinct"], function (next) {
  if (!isSelfScoped(this)) this.where(NOT_DELETED);
  next();
});

// Bulk updates must not be able to mutate a record that is already
// soft-deleted (otherwise a stale id could silently edit or revive it).
feesSchema.pre(/^(updateOne|updateMany)$/, function (next) {
  if (!isSelfScoped(this)) this.where(NOT_DELETED);
  next();
});

// Aggregations (dashboard fee totals) — scope with a leading $match.
feesSchema.pre("aggregate", function (next) {
  // Aggregate carries its options on `this.options` (there is no getOptions()).
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
// Soft delete is the only deletion path in the app. A fee that physically
// disappears would also destroy the document the audit row points at, so
// Query-level deleteOne/deleteMany are refused unless the caller says out loud
// that this is a deliberate purge.
feesSchema.pre(/^(deleteOne|deleteMany)$/, function (next) {
  const options = (this.getOptions && this.getOptions()) || {};
  if (options.allowHardDelete !== true) {
    return next(
      new Error(
        "Fee records are never hard-deleted — use deleteFeeService (soft delete + audit). " +
          "Pass { allowHardDelete: true } for a deliberate purge."
      )
    );
  }
  next();
});

module.exports = mongoose.model("Fees", feesSchema);
