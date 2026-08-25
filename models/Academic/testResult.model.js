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
