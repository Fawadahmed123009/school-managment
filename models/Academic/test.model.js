const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const testSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    subject: {
      type: ObjectId,
      ref: "Subject",
      required: true,
    },
    classLevels: [
      {
        type: ObjectId,
        ref: "ClassLevel",
        required: true,
      },
    ],
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    totalMarks: {
      type: Number,
      required: true,
      min: [1, "Total marks must be at least 1"],
    },
    passMarks: {
      type: Number,
      required: true,
      min: [0, "Pass marks cannot be negative"],
      validate: {
        validator: function (v) {
          return v <= this.totalMarks;
        },
        message: "Pass marks cannot exceed total marks",
      },
    },
    session: {
      type: ObjectId,
      ref: "TestSession",
      default: null,
    },
    phase: {
      type: ObjectId,
      default: null,
    },
    createdBy: {
      type: ObjectId,
      ref: "Admin",
      required: true,
    },
  },
  { timestamps: true }
);

const Test = mongoose.model("Test", testSchema);
module.exports = Test;
