const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const weekSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    session: {
      type: ObjectId,
      ref: "TestSession",
      required: true,
    },
    phase: {
      type: ObjectId,
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    createdBy: {
      type: ObjectId,
      ref: "Admin",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const Week = mongoose.model("Week", weekSchema);
module.exports = Week;
