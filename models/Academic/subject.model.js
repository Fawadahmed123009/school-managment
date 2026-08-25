const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const subjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      index: true,
    },
    description: {
      type: String,
    },
    // Which {gradeLevel, group} combinations this subject belongs to,
    // and whether it's compulsory (required: true) or part of a
    // student-chosen elective pool (required: false) for that combination.
    // group: null means "applies to the whole grade level" (e.g. Matric compulsory subjects).
    appliesTo: [
      {
        gradeLevel: {
          type: String,
          required: true,
          enum: ["PG", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
        },
        group: {
          type: String,
          default: null,
        },
        required: {
          type: Boolean,
          default: true,
        },
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

const Subject = mongoose.model("Subject", subjectSchema);
module.exports = Subject;
