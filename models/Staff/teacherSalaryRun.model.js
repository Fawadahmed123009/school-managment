const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

/**
 * Teacher salary run — Phase 2 (salary). NEW collection: one generated
 * salary calculation for one teacher over one custom date range. Kept
 * entirely separate from the fees/collection tables (Phase 3 links them).
 *
 * A run is a SNAPSHOT: the pay type, the rate segments actually applied, the
 * deduction rule in force and the day-wise attendance rows are all stored on
 * the run, so later rate/rule changes never rewrite a generated run.
 *
 * Lifecycle: generated as "draft" (regenerating the same teacher+period
 * replaces the draft); an admin finalizes it to lock it — finalized runs are
 * immutable. Only drafts can be deleted.
 *
 * Dates follow the attendance convention: server-LOCAL midnight, both period
 * ends inclusive (a "4th to 4th" run covers exactly that one day).
 */
const teacherSalaryRunSchema = new mongoose.Schema(
  {
    teacher: {
      type: ObjectId,
      ref: "Teacher",
      required: true,
    },
    periodStart: {
      type: Date,
      required: true,
    },
    periodEnd: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["draft", "finalized"],
      default: "draft",
    },

    // ── totals (derived from Phase 1 attendance over the exact range) ──
    totalWorkingDays: {
      type: Number,
      required: true,
      min: 0,
    },
    totalWorkingHours: {
      type: Number,
      required: true,
      min: 0,
    },
    lateDays: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Days with an arrival but no departure yet — counted as working days
    // with 0 hours; surfaced as a warning so pay is never silently short.
    incompleteDays: {
      type: Number,
      default: 0,
      min: 0,
    },
    grossAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    lateDeductionAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    netAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // ── lecture accounting (per-lecture teachers) ──
    // Default = attended days in the range; an admin may override the count
    // on the generation form. Both values are kept for the audit trail.
    lectureCountDefault: {
      type: Number,
      default: 0,
      min: 0,
    },
    lectureCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lectureOverridden: {
      type: Boolean,
      default: false,
    },

    // ── snapshots (history survives later config changes) ──
    payType: {
      type: String,
      enum: ["per-hour", "per-lecture"],
      required: true,
    },
    // One entry per rate-effective segment of the period. For per-lecture
    // runs the lecture count is apportioned across segments proportionally
    // to each segment's attended days.
    segments: [
      {
        _id: false,
        effectiveFrom: { type: Date, required: true },
        rateAmount: { type: Number, required: true },
        days: { type: Number, default: 0 },
        hours: { type: Number, default: 0 },
        lectures: { type: Number, default: 0 },
        amount: { type: Number, default: 0 },
      },
    ],
    // Deduction rule in force when the run was generated.
    deductionRule: {
      _id: false,
      enabled: { type: Boolean, default: false },
      type: { type: String, enum: ["flat", "percent"], default: "flat" },
      value: { type: Number, default: 0 },
    },
    // Day-wise attendance rows the calculation consumed (audit trail).
    days: [
      {
        _id: false,
        date: { type: Date, required: true },
        arrivalTime: { type: String, default: "" },
        departureTime: { type: String, default: "" },
        workingMinutes: { type: Number, default: 0 },
        isLate: { type: Boolean, default: false },
      },
    ],

    // ── provenance ──
    generatedBy: {
      type: ObjectId,
      required: true,
    },
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    finalizedBy: {
      type: ObjectId,
    },
    finalizedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Run history per teacher (newest period first) + status filters.
teacherSalaryRunSchema.index({ teacher: 1, periodStart: -1 });
teacherSalaryRunSchema.index({ status: 1 });

const TeacherSalaryRun = mongoose.model("TeacherSalaryRun", teacherSalaryRunSchema);
module.exports = TeacherSalaryRun;