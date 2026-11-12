const mongoose = require("mongoose");

// Expense head — Phase 3 (flexible finance). NEW collection, entirely separate
// from every existing table (fees/collections, salary, attendance). Admin-defined
// categories (Electricity, Printing — Labor, Charity Fund, Building Rent, …) so a
// new expense type never needs a code change.
//
// Heads are never hard-deleted: deactivating (isActive=false) hides a head from
// the new-entry dropdown while every past expense entry that references it stays
// intact and reportable. Case-insensitive name uniqueness is enforced in the
// service (same rule as FeeHead).
const expenseHeadSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Admin who created this head (Admin collection).
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
  },
  { timestamps: true }
);

expenseHeadSchema.index({ name: 1 });

module.exports = mongoose.model("ExpenseHead", expenseHeadSchema);
