const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const testSessionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    classLevels: [
      {
        type: ObjectId,
        ref: "ClassLevel",
      },
    ],
    phases: [
      {
        name: { type: String, required: true },
        order: { type: Number, required: true },
      },
    ],
    createdBy: {
      type: ObjectId,
      ref: "Admin",
      required: true,
    },
  },
  { timestamps: true }
);

const TestSession = mongoose.model("TestSession", testSessionSchema);
module.exports = TestSession;
