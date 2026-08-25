const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const GROUPS_9_10 = ["Computer Science", "Biology", "Arts", "Computer/Arts"];
const GROUPS_11_12 = ["Pre-Engineering", "Pre-Medical", "ICS Physics", "ICS Stats", "FA", "Commerce"];

const ClassLevelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      index: true,
    },
    gradeLevel: {
      type: String,
      required: true,
      enum: ["PG", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
    },
    group: {
      type: String,
      enum: [...GROUPS_9_10, ...GROUPS_11_12, null],
      default: null,
    },
    section: {
      type: String,
      enum: ["Boys", "Girls", null],
      default: null,
    },
    description: {
      type: String,
    },
    createdBy: {
      type: ObjectId,
      ref: "Admin",
      required: true,
    },
    students: [{ type: ObjectId, ref: "Student" }],
    subjects: [{ type: ObjectId, ref: "Subject" }],
    teachers: [{ type: ObjectId, ref: "Teacher" }],
  },
  { timestamps: true }
);

ClassLevelSchema.statics.GROUPS_9_10 = GROUPS_9_10;
ClassLevelSchema.statics.GROUPS_11_12 = GROUPS_11_12;

const ClassLevel = mongoose.model("ClassLevel", ClassLevelSchema);
module.exports = ClassLevel;
