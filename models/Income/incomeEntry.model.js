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
// Entries are immutable (create + history only) — there is no edit/delete path,
// so no soft-delete/audit fields are needed here (same as ExpenseEntry).
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
  },
  { timestamps: true }
);

// Date-wise log + per-head date-range history, and the net-summary aggregate.
incomeEntrySchema.index({ date: 1 });
incomeEntrySchema.index({ incomeHead: 1, date: 1 });

module.exports = mongoose.model("IncomeEntry", incomeEntrySchema);