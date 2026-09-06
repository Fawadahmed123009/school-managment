const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const testResultSchema = new mongoose.Schema(
  {
    test: {
      type: ObjectId,
      ref: "Test",
      required: true,
    },
    student: {
      type: ObjectId,
      ref: "Student",
      required: true,
    },
    score: {
      type: Number,
      required: true,
      min: [0, "Score cannot be negative"],
      validate: {
        validator: async function (value) {
          // `this` refers to the TestResult document being validated.
          // Look up the parent Test to check its totalMarks ceiling.
          const Test = mongoose.model("Test");
          const testDoc = await Test.findById(this.test);
          if (!testDoc) return false;
          return value <= testDoc.totalMarks;
        },
        message: "Score cannot exceed the test's total marks",
      },
    },
    markedBy: {
      type: ObjectId,
      ref: "Teacher",
      required: true,
    },
  },
  { timestamps: true }
);

// one result per student per test
testResultSchema.index({ test: 1, student: 1 }, { unique: true });

const TestResult = mongoose.model("TestResult", testResultSchema);
module.exports = TestResult;
