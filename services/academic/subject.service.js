// Import necessary models
const Subject = require("../../models/Academic/subject.model");
const ClassLevel = require("../../models/Academic/class.model");
const Program = require("../../models/Academic/program.model");
const Assignment = require("../../models/Academic/assignment.model");
const Test = require("../../models/Academic/test.model");
// Import responseStatus handler
const responseStatus = require("../../handlers/responseStatus.handler");

/**
 * Create Subject service.
 *
 * @param {Object} data - The data containing information about the Subject.
 * @param {string} data.name - The name of the Subject.
 * @param {string} data.description - The description of the Subject.
 * @param {string} data.academicTerm - The academic term associated with the Subject.
 * @param {string} programId - The ID of the program the Subject is associated with.
 * @param {string} userId - The ID of the user creating the Subject.
 * @returns {Object} - The response object indicating success or failure.
 */
exports.createSubjectService = async (data, programId, userId, res) => {
  const { name, description, appliesTo } = data;

  // Find the program
  const programFound = await Program.findById(programId);
  if (!programFound)
    return responseStatus(res, 402, "failed", "Program not found");

  // Check if a Subject with the same name already exists within this program
  const SubjectFound = await Subject.findOne({ name, program: programId });
  if (SubjectFound) {
    return responseStatus(res, 402, "failed", "Subject already exists in this program");
  }

  // Validate that all classLevel IDs in appliesTo exist (only for specific entries).
  // wholeGrade entries (with gradeLevel instead of classLevel) don't need this check.
  if (appliesTo && appliesTo.length > 0) {
    const classLevelIds = appliesTo
      .filter((a) => a.classLevel && !a.gradeLevel)
      .map((a) => a.classLevel)
      .filter(Boolean);
    if (classLevelIds.length > 0) {
      const existingClasses = await ClassLevel.find({ _id: { $in: classLevelIds } });
      if (existingClasses.length !== classLevelIds.length) {
        return responseStatus(res, 400, "failed", "One or more class levels not found");
      }
    }
  }

  // Create the Subject
  const SubjectCreated = await Subject.create({
    name,
    description,
    appliesTo,
    program: programId,
    createdBy: userId,
  });

  // Push the object ID to program
  await Program.findByIdAndUpdate(programId, { $push: { subjects: SubjectCreated._id } });

  // Send the response
  return responseStatus(res, 200, "success", SubjectCreated);
};

/**
 * Get all Subjects service.
 *
 * @returns {Array} - An array of all Subjects.
 */
exports.getAllSubjectsService = async () => {
  return await Subject.find();
};

/**
 * Get a single Subject by ID service.
 *
 * @param {string} id - The ID of the Subject.
 * @returns {Object} - The Subject object.
 */
exports.getSubjectsService = async (id) => {
  return await Subject.findById(id);
};

/**
 * Update Subject data service.
 *
 * @param {Object} data - The data containing updated information about the Subject.
 * @param {string} data.name - The updated name of the Subject.
 * @param {string} data.description - The updated description of the Subject.
 * @param {string} data.academicTerm - The updated academic term associated with the Subject.
 * @param {string} id - The ID of the Subject to be updated.
 * @param {string} userId - The ID of the user updating the Subject.
 * @returns {Object} - The response object indicating success or failure.
 */
exports.updateSubjectService = async (data, id, userId, res) => {
  const { name, description, appliesTo } = data;

  // Look up the subject being updated to get its program
  const existingSubject = await Subject.findById(id);
  if (!existingSubject) {
    return responseStatus(res, 404, "failed", "Subject not found");
  }

  // Check if the updated name already exists within the same program
  const classFound = await Subject.findOne({ name, program: existingSubject.program });
  if (classFound && classFound._id.toString() !== id) {
    return responseStatus(res, 402, "failed", "Subject already exists in this program");
  }

  // Validate that all classLevel IDs in appliesTo exist (only for specific entries).
  // wholeGrade entries (with gradeLevel instead of classLevel) don't need this check.
  if (appliesTo && appliesTo.length > 0) {
    const classLevelIds = appliesTo
      .filter((a) => a.classLevel && !a.gradeLevel)
      .map((a) => a.classLevel)
      .filter(Boolean);
    if (classLevelIds.length > 0) {
      const existingClasses = await ClassLevel.find({ _id: { $in: classLevelIds } });
      if (existingClasses.length !== classLevelIds.length) {
        return responseStatus(res, 400, "failed", "One or more class levels not found");
      }
    }
  }

  // Update the Subject
  const Subjects = await Subject.findByIdAndUpdate(
    id,
    {
      name,
      description,
      appliesTo,
      createdBy: userId,
    },
    {
      new: true,
    }
  );

  // Send the response
  return responseStatus(res, 200, "success", Subjects);
};

/**
 * Delete Subject data service.
 *
 * @param {string} id - The ID of the Subject to be deleted.
 * @returns {Object} - The deleted Subject object.
 */
exports.deleteSubjectService = async (id, res) => {
  const subject = await Subject.findById(id);
  if (!subject) return responseStatus(res, 404, "failed", "Subject not found");

  // Block deletion when any Test references this subject
  const testCount = await Test.countDocuments({ subject: id });
  if (testCount > 0) {
    return responseStatus(
      res,
      403,
      "failed",
      `Cannot delete subject: ${testCount} test(s) still reference this subject`
    );
  }

  // Cascade cleanup: delete all Assignment records referencing this subject
  await Assignment.deleteMany({ subject: id });

  // Delete the subject
  const deleted = await Subject.findByIdAndDelete(id);
  if (deleted) {
    // Remove the deleted subject's _id from every Program that references it
    await Program.updateMany({ subjects: id }, { $pull: { subjects: id } });
  }
  return responseStatus(res, 200, "success", "Subject deleted");
};
