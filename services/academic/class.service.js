const ClassLevel = require("../../models/Academic/class.model");
const Student = require("../../models/Students/students.model");
const Admin = require("../../models/Staff/admin.model");
const responseStatus = require("../../handlers/responseStatus.handler");

exports.createClassLevelService = async (data, userId, res) => {
  const { name, description, gradeLevel, group, section } = data;

  if (!name || !gradeLevel) {
    return responseStatus(res, 400, "failed", "Name and grade level are required");
  }

  const classFound = await ClassLevel.findOne({ name });
  if (classFound) {
    return responseStatus(res, 400, "failed", "Class already exists");
  }

  const classCreated = await ClassLevel.create({
    name,
    description,
    gradeLevel,
    group: group || null,
    section: section || null,
    createdBy: userId,
  });

  await Admin.findByIdAndUpdate(userId, { $push: { classLevels: classCreated._id } });

  return responseStatus(res, 200, "success", classCreated);
};

exports.getAllClassesService = async () => {
  const classes = await ClassLevel.find()
    .sort({ gradeLevel: 1, group: 1, section: 1 })
    .lean();

  // ClassLevel.students is a legacy array that nothing in the codebase ever
  // populates, so it can't be trusted for enrollment checks. Compute real
  // per-class student counts with a single aggregation against Student.
  const counts = await Student.aggregate([
    { $group: { _id: "$classLevel", count: { $sum: 1 } } },
  ]);
  const countById = new Map(counts.map((c) => [String(c._id), c.count]));

  return classes.map((c) => ({
    ...c,
    studentCount: countById.get(String(c._id)) || 0,
  }));
};

exports.getClassLevelsService = async (id) => {
  return await ClassLevel.findById(id);
};

exports.updateClassLevelService = async (data, id, userId, res) => {
  const { name, description, gradeLevel, group, section } = data;

  if (name) {
    const classFound = await ClassLevel.findOne({ name, _id: { $ne: id } });
    if (classFound) {
      return responseStatus(res, 400, "failed", "Another class already uses that name");
    }
  }

  const classLevel = await ClassLevel.findByIdAndUpdate(
    id,
    {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(gradeLevel !== undefined && { gradeLevel }),
      ...(group !== undefined && { group: group || null }),
      ...(section !== undefined && { section: section || null }),
    },
    { new: true }
  );

  if (!classLevel) return responseStatus(res, 404, "failed", "Class not found");

  return responseStatus(res, 200, "success", classLevel);
};

exports.deleteClassLevelService = async (id, res) => {
  const deleted = await ClassLevel.findByIdAndDelete(id);
  if (!deleted) return responseStatus(res, 404, "failed", "Class not found");
  return responseStatus(res, 200, "success", deleted);
};
