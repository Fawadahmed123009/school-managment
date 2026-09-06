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
        validator: (v) => v > 0,
        message: "Fee amount must be greater than zero",
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
  },
  { timestamps: true }
);

module.exports = mongoose.model("Fees", feesSchema);
