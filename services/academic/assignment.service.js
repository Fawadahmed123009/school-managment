const responseStatus = require("../../handlers/responseStatus.handler");
const Assignment = require("../../models/Academic/assignment.model");
const Subject = require("../../models/Academic/subject.model");
const ClassLevel = require("../../models/Academic/class.model");

exports.createAssignmentService = async (data, adminId, res) => {
  const { teacher, subject, classLevel } = data;

  const subjectDoc = await Subject.findById(subject);
  if (!subjectDoc) return responseStatus(res, 404, "failed", "Subject not found");

  const classDoc = await ClassLevel.findById(classLevel);
  if (!classDoc) return responseStatus(res, 404, "failed", "Class not found");

  const applies = subjectDoc.appliesTo.some((a) => {
    const gradeMatches = a.gradeLevel === classDoc.gradeLevel;
    const groupMatches = a.group === null || a.group === classDoc.group;
    return gradeMatches && groupMatches;
  });

  if (!applies) {
    return responseStatus(
      res,
      400,
      "failed",
      `"${subjectDoc.name}" is not taught in "${classDoc.name}" (grade ${classDoc.gradeLevel}${classDoc.group ? ", " + classDoc.group : ""})`
    );
  }

  const existing = await Assignment.findOne({ teacher, subject, classLevel });
  if (existing) {
    return responseStatus(res, 400, "failed", "This teacher is already assigned to this subject for this class");
  }

  const assignment = await Assignment.create({ teacher, subject, classLevel, createdBy: adminId });
  return responseStatus(res, 201, "success", assignment);
};

exports.getAllAssignmentsService = async (res) => {
  const assignments = await Assignment.find({})
    .populate("teacher", "name teacherId")
    .populate("subject", "name")
    .populate("classLevel", "name gradeLevel group section");
  return responseStatus(res, 200, "success", assignments);
};

exports.getMyAssignmentsService = async (teacherId, res) => {
  const assignments = await Assignment.find({ teacher: teacherId })
    .populate("subject", "name")
    .populate("classLevel", "name gradeLevel group section");
  return responseStatus(res, 200, "success", assignments);
};

exports.deleteAssignmentService = async (assignmentId, res) => {
  const assignment = await Assignment.findByIdAndDelete(assignmentId);
  if (!assignment) return responseStatus(res, 404, "failed", "Assignment not found");
  return responseStatus(res, 200, "success", "Assignment removed");
};

exports.isTeacherAssigned = async (teacherId, subjectId, classLevelId) => {
  const assignment = await Assignment.findOne({ teacher: teacherId, subject: subjectId, classLevel: classLevelId });
  return !!assignment;
};

// Given a set of classLevels (e.g. every section a test covers), returns only
// the ones this teacher is actually assigned to teach `subjectId` for. Used to
// scope a test's roster/submission down to the teacher's own sections: on a
// multi-section test, a teacher assigned to one section must neither see nor
// grade students in the sections they don't teach.
exports.getAssignedClassLevels = async (teacherId, subjectId, classLevelIds) => {
  const ids = (Array.isArray(classLevelIds) ? classLevelIds : [classLevelIds]).filter(Boolean);
  if (ids.length === 0) return [];
  const assignments = await Assignment.find({
    teacher: teacherId,
    subject: subjectId,
    classLevel: { $in: ids },
  }).select("classLevel");
  return assignments.map((a) => a.classLevel);
};
