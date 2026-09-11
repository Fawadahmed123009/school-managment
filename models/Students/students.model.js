const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const studentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true,
    },
    email: {
      type: String,
      trim: true,
      required: true,
      index: true,
    },
    password: {
      type: String,
      trim: true,
      required: true,
    },
    rollNumber: {
      type: String,
      trim: true,
      required: true,
    },
    studentId: {
      type: String,
      trim: true,
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
      trim: true,
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
      trim: true,
      enum: ["active", "inactive"],
      default: "active",
    },
    fatherName: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    whatsappNumber: {
      type: String,
      trim: true,
      default: "",
    },
    feeAgreed: {
      type: String,
      trim: true,
      default: null,
    },
    gender: {
      type: String,
      trim: true,
      enum: ["Male", "Female"],
      default: "Male",
    },
    prefectName: {
      type: String,
      trim: true,
    },
    religion: {
      type: String,
      trim: true,
      enum: ["Muslim", "Non-Muslim"],
      default: "Muslim",
    },
    photoUrl: {
      type: String,
      trim: true,
      default: null,
    },
    familyNumber: {
      type: String,
      trim: true,
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
      trim: true,
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
