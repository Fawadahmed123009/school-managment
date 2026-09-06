const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const subjectSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
    },
    program: {
      type: ObjectId,
      ref: "Program",
      required: true,
    },
    // Which ClassLevel documents or grade levels this subject belongs to.
    // Two entry types are supported:
    //   (1) specific:   { classLevel: ObjectId, required: Boolean }
    //                   Applies to one exact ClassLevel.
    //   (2) wholeGrade: { gradeLevel: String,   required: Boolean }
    //                   Applies to every ClassLevel in that grade
    //                   regardless of group, including classes created later.
    appliesTo: [
      {
        classLevel: {
          type: ObjectId,
          ref: "ClassLevel",
        },
        gradeLevel: {
          type: String,
          enum: ["PG", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"],
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

// Compound unique index: same name allowed under different programs,
// but blocked from being duplicated within the same program.
subjectSchema.index({ name: 1, program: 1 }, { unique: true });

const Subject = mongoose.model("Subject", subjectSchema);
module.exports = Subject;
