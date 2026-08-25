const {
  hashPassword,
  isPassMatched,
} = require("../../handlers/passHash.handler");
const Teacher = require("../../models/Staff/teachers.model");
const Admin = require("../../models/Staff/admin.model");
const generateToken = require("../../utils/tokenGenerator");
const responseStatus = require("../../handlers/responseStatus.handler");
const { paginate } = require("../../utils/paginate");

exports.createTeacherService = async (data, adminId, res) => {
  const { name, email, password } = data;

  const existTeacher = await Teacher.findOne({ email });
  if (existTeacher)
    return responseStatus(res, 402, "failed", "Teacher already exists");

  const hashedPassword = await hashPassword(password);

  const admin = await Admin.findById(adminId);
  if (!admin) return responseStatus(res, 401, "fail", "Unauthorized access");

  const createTeacher = await Teacher.create({
    name,
    email,
    password: hashedPassword,
    createdBy: admin._id,
  });

  await Admin.findByIdAndUpdate(adminId, { $push: { teachers: createTeacher._id } });

  return responseStatus(res, 200, "success", createTeacher);
};

exports.teacherLoginService = async (data, res) => {
  const { email, password } = data;

  const teacherFound = await Teacher.findOne({ email });
  if (!teacherFound)
    return responseStatus(res, 402, "failed", "Invalid login credentials");

  const isMatched = await isPassMatched(password, teacherFound?.password);
  if (!isMatched)
    return responseStatus(res, 401, "failed", "Invalid login credentials");

  const responseTeacher = teacherFound.toObject();
  delete responseTeacher.password;

  const response = {
    teacher: responseTeacher,
    token: generateToken(teacherFound._id),
  };

  return responseStatus(res, 200, "success", response);
};

exports.getAllTeachersService = async (query) => {
  return await paginate(Teacher, {}, {
    page: query.page,
    limit: query.limit,
    select: "-password",
    sort: "name",
  });
};

exports.getTeacherProfileService = async (teacherId) => {
  return await Teacher.findById(teacherId).select(
    "-createdAt -updatedAt -password"
  );
};

exports.adminGetTeacherService = async (teacherId) => {
  return await Teacher.findById(teacherId).select(
    "-createdAt -updatedAt -password"
  );
};

exports.updateTeacherProfileService = async (data, teacherId, res) => {
  const { name, email, password } = data;

  if (email) {
    const emailExist = await Teacher.findOne({
      email,
      _id: { $ne: teacherId },
    });
    if (emailExist)
      return responseStatus(res, 402, "failed", "Email already in use");
  }

  const hashedPassword = password ? await hashPassword(password) : null;

  const updateData = {
    name,
    email,
    ...(hashedPassword && { password: hashedPassword }),
  };

  const updatedTeacher = await Teacher.findByIdAndUpdate(
    teacherId,
    updateData,
    { new: true }
  );

  return { teacher: updatedTeacher, token: generateToken(updatedTeacher._id) };
};

exports.adminUpdateTeacherProfileService = async (data, teacherId, res) => {
  const { program, classLevel, academicYear, subject } = data;

  const updateFields = {};
  if (program) updateFields.program = program;
  if (classLevel) updateFields.classLevel = classLevel;
  if (academicYear) updateFields.academicYear = academicYear;
  if (subject) updateFields.subject = subject;

  const updatedTeacher = await Teacher.findByIdAndUpdate(
    teacherId,
    { $set: updateFields },
    { new: true }
  );
  if (!updatedTeacher) return responseStatus(res, 404, "failed", "No such teacher found");

  const responseTeacher = updatedTeacher.toObject();
  delete responseTeacher.password;
  return responseStatus(res, 200, "success", responseTeacher);
};

exports.toggleAttendanceManagerService = async (teacherId, res) => {
  const teacher = await Teacher.findById(teacherId);
  if (!teacher) return responseStatus(res, 404, "failed", "Teacher not found");

  const updatedTeacher = await Teacher.findByIdAndUpdate(
    teacherId,
    { isAttendanceManager: !teacher.isAttendanceManager },
    { new: true }
  );

  const responseTeacher = updatedTeacher.toObject();
  delete responseTeacher.password;
  return responseStatus(res, 200, "success", responseTeacher);
};

/**
 * Admin updates a teacher's name / email / password.
 * @route PUT /api/v1/teacher/:teacherId/credentials
 */
exports.adminUpdateCredentialsService = async (data, teacherId, res) => {
  const { name, email, password } = data;

  const teacher = await Teacher.findById(teacherId);
  if (!teacher) return responseStatus(res, 404, "failed", "Teacher not found");

  // If changing email, check uniqueness
  if (email && email !== teacher.email) {
    const emailTaken = await Teacher.findOne({ email, _id: { $ne: teacherId } });
    if (emailTaken) return responseStatus(res, 402, "failed", "Email already in use");
  }

  const updateFields = {};
  if (name) updateFields.name = name;
  if (email) updateFields.email = email;
  if (password) updateFields.password = await hashPassword(password);

  const updatedTeacher = await Teacher.findByIdAndUpdate(
    teacherId,
    { $set: updateFields },
    { new: true }
  );

  const responseTeacher = updatedTeacher.toObject();
  delete responseTeacher.password;
  return responseStatus(res, 200, "success", responseTeacher);
};

/**
 * Admin deletes a teacher.
 * @route DELETE /api/v1/teacher/:teacherId
 */
exports.deleteTeacherService = async (teacherId, res) => {
  const teacher = await Teacher.findById(teacherId);
  if (!teacher) return responseStatus(res, 404, "failed", "Teacher not found");

  // Remove teacher reference from the admin who created it
  await Admin.findByIdAndUpdate(teacher.createdBy, {
    $pull: { teachers: teacher._id },
  });

  await Teacher.findByIdAndDelete(teacherId);

  return responseStatus(res, 200, "success", "Teacher deleted");
};
