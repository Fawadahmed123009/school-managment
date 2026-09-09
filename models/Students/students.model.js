const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const studentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
    },
    rollNumber: {
      type: Number,
      required: true,
      min: [1, "Roll number must be at least 1"],
    },
    studentId: {
      type: String,
      required: true,
      default: function () {
        return (
          "STU" +
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
    role: {
      type: String,
      default: "student",
    },
    classLevel: {
      type: ObjectId,
      ref: "ClassLevel",
      required: true,
    },
 
    academicYear: {
      type: ObjectId,
      ref: "AcademicYear",
    },
    dateAdmitted: {
      type: Date,
      default: Date.now,
    },
    examResults: [
      {
        type: ObjectId,
        ref: "ExamResult",
      },
    ],
    program: {
      type: ObjectId,
      ref: "Program",
    },
    isGraduated: {
      type: Boolean,
      default: false,
    },
    isWithdrawn: {
      type: Boolean,
      default: false,
    },
    isSuspended: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    fatherName: {
      type: String,
      default: "",
    },
    address: {
      type: String,
      default: "",
    },
    whatsappNumber: {
      type: String,
      default: "",
    },
    feeAgreed: {
      type: Number,
      default: null,
    },
    gender: {
      type: String,
      enum: ["Male", "Female"],
      default: "Male",
    },
    prefectName: {
      type: String,
    },
    religion: {
      type: String,
      enum: ["Muslim", "Non-Muslim"],
      default: "Muslim",
    },
    photoUrl: {
      type: String,
      default: null,
    },
    familyNumber: {
      type: String,
      default: null,
      index: true,
    },
    parent: {
      type: ObjectId,
      ref: "Parent",
      default: null,
    },
    // both are commented for future update
    // behaviorReport: [
    //   {
    //     type: ObjectId,
    //     ref: "BehaviorReport",
    //   },
    // ],
    // financialReport: [
    //   {
    //     type: ObjectId,
    //     ref: "FinancialReport",
    //   },
    // ],
    //year group
    yearGraduated: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

//model
studentSchema.index({ classLevel: 1, rollNumber: 1 }, { unique: true });

const Student = mongoose.model("Student", studentSchema);

module.exports = Student;
