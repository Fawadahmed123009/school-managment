const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

/**
 * Admin-configured late-arrival rule for teacher attendance (Phase 1).
 * NEW singleton lookup collection — kept separate from every existing table.
 *
 * Late = arrival later than `startTime` (the expected entry time) +
 * `graceMinutes` (default 5). Detection is DISABLED by default; until an
 * admin enables it every record is written with isLate=false / lateMinutes=0.
 * Whether lateness affects pay is Phase 2 — this document holds no
 * money/deduction amounts.
 *
 * Singleton enforced by the unique `key` index; the service always upserts
 * on { key: "default" }.
 */
const teacherAttendanceSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "default",
      unique: true,
    },
    lateDetectionEnabled: {
      type: Boolean,
      default: false,
    },
    // Expected arrival time, "HH:MM" 24-hour (validated in the service layer).
    startTime: {
      type: String,
      default: "08:00",
    },
    // Grace period in minutes after startTime before an arrival counts late.
    // Default 5 (the standing rule); an admin can change it at any time.
    graceMinutes: {
      type: Number,
      default: 5,
      min: 0,
    },
    // Admin who last changed the rule.
    updatedBy: {
      type: ObjectId,
    },
  },
  { timestamps: true }
);

const TeacherAttendanceSettings = mongoose.model(
  "TeacherAttendanceSettings",
  teacherAttendanceSettingsSchema
);
module.exports = TeacherAttendanceSettings;