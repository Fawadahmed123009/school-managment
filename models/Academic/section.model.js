const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const sectionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: ObjectId,
      ref: "Admin",
      default: null,
    },
  },
  { timestamps: true }
);

const Section = mongoose.model("Section", sectionSchema);
module.exports = Section;
