const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const teacherSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true, // H1: per-collection email uniqueness (email_unique)
      index: true,
    },
    // WhatsApp / mobile number used for marking-reminder messages. Stored as the
    // admin entered it; the marks-audit view strips non-digits to build a wa.me
    // link, so an international format (e.g. +92 300 1234567) is best.
    whatsappNumber: {
      type: String,
      trim: true,
      default: "",
    },
    password: {
      type: String,
      required: true,
    },
    dateEmployed: {
      type: Date,
      default: Date.now,
    },
    teacherId: {
      type: String,
      required: true,
      default: function () {
        return (
          "TEA" +
          Math.floor(100 + Math.random() * 900) +
          Date.now().toString().slice(2, 4) +
          this.name
            .split(" ")
            .map((name) => name[0])
            .join("")
            .toUpperCase()
        );
      },
    },
    //if withdrawn, the teacher will not be able to login
    isWithdrawn: {
      type: Boolean,
      default: false,
    },
    //if suspended, the teacher can login but cannot perform any task
    isSuspended: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      default: "teacher",
    },
    subject: {
      type: ObjectId,
      ref: "Subject",
      // required: true,
    },
    applicationStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    isAttendanceManager: {
      type: Boolean,
      default: false,
    },
    // Expected working hours (staff profile), "HH:MM" 24-hour. The teacher
    // attendance late-check compares a login-captured arrival against
    // expectedArrivalTime + the admin grace period. OPTIONAL by design: ""
    // means not set yet → late detection is SKIPPED for this teacher (no
    // false positives) until an Admin/Manager fills it in. Blank existing
    // docs are unaffected — the field simply defaults to "" on read/write.
    expectedArrivalTime: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator: (v) => v === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
        message: "Expected arrival time must be a HH:MM (24-hour) time",
      },
    },
    // Recorded for the schedule picture (and future early-departure / salary
    // phases); Phase 1 lateness only uses the arrival side.
    expectedDepartureTime: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator: (v) => v === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
        message: "Expected departure time must be a HH:MM (24-hour) time",
      },
    },

    program: {
      type: String,
    },
    //A teacher can teach in more than one class level
    classLevel: {
      type: String,
    },
    academicYear: {
      type: String,
    },
    examsCreated: [
      {
        type: ObjectId,
        ref: "Exam",
      },
    ],
    createdBy: {
      type: ObjectId,
      ref: "Admin",
      required: true,
    },
    academicTerm: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

//model
const Teacher = mongoose.model("Teacher", teacherSchema);

module.exports = Teacher;
