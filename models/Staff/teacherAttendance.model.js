const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

/**
 * Teacher (staff) attendance — Phase 1 of the teacher-attendance → salary
 * feature. NEW collection, entirely separate from the student `Attendance`
 * collection: one arrival/departure record per teacher per day, marked by a
 * manager or admin.
 *
 * `date` follows the same convention as student attendance: server-LOCAL
 * midnight (see utils/localDateKey.js for the day-key helpers).
 *
 * `workingMinutes`, `isLate` and `lateMinutes` are DERIVED at write time from
 * arrival/departure and the admin-configured late rule
 * (TeacherAttendanceSettings). They are stored so Phase 2 (salary) can sum
 * them without recomputing; no pay/deduction amounts live here.
 *
 * Capture provenance per time field (`*Source`):
 *   • manual — a manager/admin marks or corrects the day (source "manual");
 *     this is the ONLY path that writes new records now.
 *   • login / logout — HISTORICAL ONLY. Earlier versions auto-captured a
 *     teacher's arrival from their first login and departure from logout.
 *     That auto-capture has been retired; existing "login"/"logout" rows are
 *     preserved untouched for reference, and the enum values stay so those
 *     documents remain valid and readable.
 * Documents written before source tracking existed have no source fields —
 * readers must treat a missing source as "manual".
 */
const teacherAttendanceSchema = new mongoose.Schema(
  {
    teacher: {
      type: ObjectId,
      ref: "Teacher",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    // "HH:MM" 24-hour, to the minute (validated in the service layer).
    arrivalTime: {
      type: String,
      required: true,
    },
    // Empty until a logout is captured or a manager marks it — a login-only
    // day is a valid in-progress record.
    departureTime: {
      type: String,
      default: "",
    },
    // Derived: departure − arrival, in minutes (same-day shifts only).
    // 0 while a captured day has no departure yet.
    workingMinutes: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    // Derived flag: arrival later than the configured start time + grace.
    // Always false while late detection is disabled (the default).
    isLate: {
      type: Boolean,
      default: false,
    },
    // Derived: minutes past start + grace (0 when not late). Kept for the
    // Phase 2 salary calculation — this phase never turns it into money.
    lateMinutes: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Manager (Teacher) or Admin who first marked this day. Plain ObjectId —
    // the marker can belong to either collection. For login-captured records
    // the teacher themself is the creator (the login wrote the row).
    createdBy: {
      type: ObjectId,
      required: true,
    },
    // Who last edited the record (upserts keep createdBy intact).
    updatedBy: {
      type: ObjectId,
    },
    // Capture provenance per time field. Missing on pre-login-capture
    // documents = "manual" (manager-marked). Auto paths only refine auto
    // times; an explicit manager correction always wins.
    arrivalSource: {
      type: String,
      enum: ["login", "manual"],
      default: "manual",
    },
    departureSource: {
      type: String,
      enum: ["logout", "manual"],
      default: "manual",
    },
  },
  { timestamps: true }
);

// One attendance record per teacher per day (upsert key on the marking path).
teacherAttendanceSchema.index({ teacher: 1, date: 1 }, { unique: true });

// Date-range history/summary queries across all teachers (the compound index
// above can't serve a bare date filter — teacher is its prefix).
teacherAttendanceSchema.index({ date: 1 });

const TeacherAttendance = mongoose.model("TeacherAttendance", teacherAttendanceSchema);
module.exports = TeacherAttendance;