const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

/**
 * Admin-configured late-deduction rule for teacher salary (Phase 2).
 * NEW singleton lookup collection — kept separate from every existing table,
 * including the Phase 1 TeacherAttendanceSettings (which only flags lateness
 * and holds no money amounts).
 *
 * The deduction applies to a salary run ONLY when this rule is enabled AND
 * Phase 1 late detection is enabled AND the run has late days:
 *   • flat    — lateDays × flatAmount (a fixed cut per late day);
 *   • percent — percentValue% of the gross attributable to late days
 *               (gross × lateDays / workingDays), capped at the gross.
 * Disabled by default — until an admin enables it, lateness never costs pay.
 *
 * Singleton enforced by the unique `key` index; the service always upserts
 * on { key: "default" }.
 */
const teacherSalarySettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "default",
      unique: true,
    },
    lateDeductionEnabled: {
      type: Boolean,
      default: false,
    },
    deductionType: {
      type: String,
      enum: ["flat", "percent"],
      default: "flat",
    },
    // Flat mode: rupees deducted per late day.
    flatAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Percent mode: % of the late-day share of gross (0–100).
    percentValue: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // Admin who last changed the rule.
    updatedBy: {
      type: ObjectId,
    },
  },
  { timestamps: true }
);

const TeacherSalarySettings = mongoose.model(
  "TeacherSalarySettings",
  teacherSalarySettingsSchema
);
module.exports = TeacherSalarySettings;