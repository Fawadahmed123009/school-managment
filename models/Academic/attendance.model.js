const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const attendanceSchema = new mongoose.Schema(
  {
    student: {
      type: ObjectId,
      ref: "Student",
      required: true,
    },
    classLevel: {
      type: ObjectId,
      ref: "ClassLevel",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["present", "absent", "late"],
      required: true,
    },
    markedBy: {
      type: ObjectId,
      ref: "Teacher",
      required: true,
    },
  },
  { timestamps: true }
);

// one attendance record per student per day
attendanceSchema.index({ student: 1, date: 1 }, { unique: true });

// Query-audit index: date-range queries across all students (the compound
// index above can't serve a bare date filter — student is its prefix).
attendanceSchema.index({ date: 1 });

// TTL index removed — attendance records are retained indefinitely

const Attendance = mongoose.model("Attendance", attendanceSchema);
module.exports = Attendance;
