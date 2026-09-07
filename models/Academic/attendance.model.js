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

// Auto-expire attendance records after 90 days
attendanceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const Attendance = mongoose.model("Attendance", attendanceSchema);
module.exports = Attendance;
