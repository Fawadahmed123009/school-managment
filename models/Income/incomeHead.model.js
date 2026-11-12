const mongoose = require("mongoose");

// Income head — flexible ad-hoc income (parallel to Phase 3 Expenses). NEW
// collection, entirely separate from every existing table (fees/collections,
// salary, expenses, attendance). Admin-defined categories (Notes Sale, Old
// Furniture Sale, Donation Received, …) for income that does NOT fit the
// per-student/per-class fee structure — a handful of buyers at irregular times.
//
// Heads are never hard-deleted: deactivating (isActive=false) hides a head from
// the new-entry dropdown while every past income entry that references it stays
// intact and reportable. Case-insensitive name uniqueness is enforced in the
// service (same rule as FeeHead / ExpenseHead).
const incomeHeadSchema = new mongoose.Schema(
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

incomeHeadSchema.index({ name: 1 });

module.exports = mongoose.model("IncomeHead", incomeHeadSchema);