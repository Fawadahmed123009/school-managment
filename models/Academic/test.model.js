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
    week: {
      type: ObjectId,
      ref: "Week",
      default: null,
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

// Query-audit indexes: session+date listing, per-subject lookups ($in),
// week- and phase-scoped filters.
testSchema.index({ session: 1, date: -1 });
// Unscoped newest-first listing (Test.find({}).sort({date:-1})) can't use the
// compound index above — a global date sort needs date as the leading field.
testSchema.index({ date: -1 });
testSchema.index({ subject: 1 });
testSchema.index({ week: 1 });
testSchema.index({ phase: 1 });

const Test = mongoose.model("Test", testSchema);
module.exports = Test;
