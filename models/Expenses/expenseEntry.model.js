const mongoose = require("mongoose");

// Expense entry — Phase 3 (flexible finance). NEW collection, independent of
// attendance/salary/fees. One row per recorded expense.
//
// totalAmount is ALWAYS derived server-side as round2(quantity × unitRate); a
// client-supplied total is never trusted (same fail-closed rule as salary runs).
// `date` follows the attendance/salary convention: server-LOCAL midnight, and
// date-range filters are inclusive on both ends (see the entry service).
//
// Entries are immutable in Phase 3 (create + history only) — there is no
// edit/delete path, so no soft-delete/audit fields are needed here.
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
  },
  { timestamps: true }
);

// Date-wise log + per-head date-range history (Phase 4 collections-vs-expenses).
expenseEntrySchema.index({ date: 1 });
expenseEntrySchema.index({ expenseHead: 1, date: 1 });

module.exports = mongoose.model("ExpenseEntry", expenseEntrySchema);
