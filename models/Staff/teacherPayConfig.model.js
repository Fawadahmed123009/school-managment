const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

/**
 * Teacher pay configuration — Phase 2 (salary) of the teacher-attendance →
 * salary feature. NEW collection, entirely separate from every existing
 * table (including the Phase 1 attendance collections and the fees/collection
 * tables — Phase 3 will link those later).
 *
 * INSERT-ONLY rate history: when an admin changes a teacher's pay type or
 * rate a NEW row is inserted with its own `effectiveFrom`; existing rows are
 * never updated or deleted. A salary run resolves the rate that was effective
 * during its period from this history, so past runs stay accurate even after
 * later rate changes.
 *
 * `effectiveFrom` follows the attendance date convention: server-LOCAL
 * midnight (see the parseDayStart helper in the salary service).
 */
const teacherPayConfigSchema = new mongoose.Schema(
  {
    teacher: {
      type: ObjectId,
      ref: "Teacher",
      required: true,
    },
    // How the teacher is paid: working hours × rate, or lectures × rate.
    payType: {
      type: String,
      enum: ["per-hour", "per-lecture"],
      required: true,
    },
    // Rupees per hour / per lecture. Must be positive — a zero rate would
    // silently produce Rs 0 runs, which the feature explicitly forbids.
    rateAmount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    // First day (inclusive, local midnight) this rate applies. The newest
    // row with effectiveFrom <= a given day is the rate effective that day.
    effectiveFrom: {
      type: Date,
      required: true,
    },
    // Admin who set this rate (plain ObjectId — Admin collection).
    createdBy: {
      type: ObjectId,
      required: true,
    },
  },
  { timestamps: true }
);

// Rate-history lookup: newest effective row per teacher (also serves the
// "current rate" read, which is just the first row of this sort).
teacherPayConfigSchema.index({ teacher: 1, effectiveFrom: -1 });

const TeacherPayConfig = mongoose.model("TeacherPayConfig", teacherPayConfigSchema);
module.exports = TeacherPayConfig;