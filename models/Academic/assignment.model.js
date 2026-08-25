const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const assignmentSchema = new mongoose.Schema(
  {
    teacher: {
      type: ObjectId,
      ref: "Teacher",
      required: true,
    },
    subject: {
      type: ObjectId,
      ref: "Subject",
      required: true,
    },
    classLevel: {
      type: ObjectId,
      ref: "ClassLevel",
      required: true,
    },
    createdBy: {
      type: ObjectId,
      ref: "Admin",
      required: true,
    },
  },
  { timestamps: true }
);

// prevent the exact same assignment being created twice
assignmentSchema.index({ teacher: 1, subject: 1, classLevel: 1 }, { unique: true });

const Assignment = mongoose.model("Assignment", assignmentSchema);
module.exports = Assignment;
