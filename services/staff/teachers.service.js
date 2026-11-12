const {
  hashPassword,
  isPassMatched,
  validatePassword,
} = require("../../handlers/passHash.handler");
const Teacher = require("../../models/Staff/teachers.model");
const Admin = require("../../models/Staff/admin.model");
const Assignment = require("../../models/Academic/assignment.model");
const TestResult = require("../../models/Academic/testResult.model");
const Attendance = require("../../models/Academic/attendance.model");
const generateToken = require("../../utils/tokenGenerator");
const responseStatus = require("../../handlers/responseStatus.handler");
const { paginate } = require("../../utils/paginate");
const { isValidTime } = require("../../utils/teacherAttendanceTime");
const { recordTeacherLoginArrival } = require("./teacherAttendance.service");
const { recordAudit, changedFields } = require("../audit/auditLog.service");
const logger = require("../../config/logger");

/**
 * Expected working hours (staff profile) share one strict blank contract:
 *   undefined → field not in this request → leave whatever is stored alone
 *   ""        → explicit clear (the form shows the stored value, so a blank
 *               submit is intentional)
 *   "HH:MM"   → set
 *   anything else → null → caller rejects with 400 BEFORE any write.
 */
function sanitizeExpectedTime(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (s === "") return "";
  return isValidTime(s) ? s : null;
}

exports.createTeacherService = async (data, adminId, res) => {
  const { name, email, password, whatsappNumber } = data;

  // Expected times are optional at creation — validated up front, before any
  // side effect, so a malformed value can never half-create an account.
  const expectedArrivalTime = sanitizeExpectedTime(data.expectedArrivalTime);
  const expectedDepartureTime = sanitizeExpectedTime(data.expectedDepartureTime);
  if (expectedArrivalTime === null || expectedDepartureTime === null) {
    return responseStatus(res, 400, "failed", "Expected times must be HH:MM (24-hour) times");
  }

  const existTeacher = await Teacher.findOne({ email });
  if (existTeacher)
    return responseStatus(res, 402, "failed", "Teacher already exists");

  const hashedPassword = await hashPassword(password);

  // Accept both admins and managers (teachers with isAttendanceManager).
  const [admin, callerTeacher] = await Promise.all([
    Admin.findById(adminId),
    Teacher.findById(adminId).select("isAttendanceManager").lean(),
  ]);
  const isManager = callerTeacher && callerTeacher.isAttendanceManager;
  if (!admin && !isManager) {
    return responseStatus(res, 401, "fail", "Unauthorized access");
  }

  const createTeacher = await Teacher.create({
    name,
    email,
    password: hashedPassword,
    whatsappNumber: whatsappNumber ? String(whatsappNumber).trim() : "",
    // "" when not supplied → late detection stays skipped until set.
    expectedArrivalTime: expectedArrivalTime || "",
    expectedDepartureTime: expectedDepartureTime || "",
    createdBy: admin ? admin._id : adminId,
  });

  // Track the new teacher on the admin's record (managers don't have a
  // teachers array, so this only applies when the caller is an admin).
  if (admin) {
    await Admin.findByIdAndUpdate(adminId, { $push: { teachers: createTeacher._id } });
  }

  // Audit trail (fail-open): expected times set at creation count as "set".
  if (expectedArrivalTime || expectedDepartureTime) {
    recordAudit({
      userId: adminId,
      actionType: "create",
      entityType: "teacher_expected_times",
      entityId: createTeacher._id,
      summary: `Set expected times for new teacher ${createTeacher.name} (arrival ${expectedArrivalTime || "—"}, departure ${expectedDepartureTime || "—"})`,
      afterSnapshot: {
        expectedArrivalTime: expectedArrivalTime || "",
        expectedDepartureTime: expectedDepartureTime || "",
      },
    });
  }

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

  // Staff attendance (Phase 1): the first login of the day IS the arrival
  // record. Best-effort — a capture hiccup must never break or delay the
  // login itself, so failures are logged and swallowed here.
  if (!teacherFound.isWithdrawn) {
    try {
      await recordTeacherLoginArrival(teacherFound._id);
    } catch (e) {
      logger.warn(`teacher-attendance login capture failed: ${e.message}`);
    }
  }

  const response = {
    teacher: responseTeacher,
    token: generateToken(teacherFound._id),
  };

  return responseStatus(res, 200, "success", response);
};

exports.getAllTeachersService = async (query) => {
  const filter = {};
  const search = (query.search || "").trim();
  if (search) filter.name = { $regex: search, $options: "i" };

  return await paginate(Teacher, filter, {
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

/**
 * Teacher self-service: edit own name / email / WhatsApp number / password
 * from the dashboard Settings panel. Mirrors the parent portal's
 * change-password flow: a password change requires the current password and
 * must pass the shared password policy. Name/email changes and a cleared
 * number are allowed in the same submit.
 * @route POST /api/v1/teacher/account-settings
 */
exports.updateTeacherAccountSettingsService = async (data, teacherId, res) => {
  const { name, email, whatsappNumber, currentPassword, newPassword, confirmPassword } = data;

  const teacher = await Teacher.findById(teacherId);
  if (!teacher) return responseStatus(res, 404, "failed", "Teacher not found");

  const updateFields = {};

  const cleanName = (name || "").trim();
  if (cleanName) updateFields.name = cleanName;

  const cleanEmail = (email || "").trim();
  if (cleanEmail && cleanEmail !== teacher.email) {
    const emailTaken = await Teacher.findOne({ email: cleanEmail, _id: { $ne: teacherId } });
    if (emailTaken)
      return responseStatus(res, 402, "failed", "Email already in use");
    updateFields.email = cleanEmail;
  }

  // The number is optional and may legitimately be cleared, so accept any
  // provided string (including "") rather than only truthy values.
  if (whatsappNumber !== undefined) {
    updateFields.whatsappNumber = String(whatsappNumber).trim();
  }

  // Password change is opt-in: only when a new password is supplied.
  if (newPassword) {
    if (!currentPassword) {
      return responseStatus(res, 400, "failed", "Current password is required to change your password");
    }
    if (newPassword !== confirmPassword) {
      return responseStatus(res, 400, "failed", "New passwords do not match");
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return responseStatus(res, 400, "failed", passwordError);
    }
    const isMatch = await isPassMatched(currentPassword, teacher.password);
    if (!isMatch) {
      return responseStatus(res, 401, "failed", "Current password is incorrect");
    }
    updateFields.password = await hashPassword(newPassword);
  }

  if (Object.keys(updateFields).length === 0) {
    return responseStatus(res, 400, "failed", "Nothing to update");
  }

  const updatedTeacher = await Teacher.findByIdAndUpdate(
    teacherId,
    { $set: updateFields },
    { new: true }
  ).select("-password");

  return responseStatus(res, 200, "success", { teacher: updatedTeacher });
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
 * `adminId` is optional (audit trail only) — the acting admin/manager.
 * @route PUT /api/v1/teacher/:teacherId/credentials
 */
exports.adminUpdateCredentialsService = async (data, teacherId, res, adminId) => {
  const { name, email, password, whatsappNumber } = data;

  const expectedArrivalTime = sanitizeExpectedTime(data.expectedArrivalTime);
  const expectedDepartureTime = sanitizeExpectedTime(data.expectedDepartureTime);
  if (expectedArrivalTime === null || expectedDepartureTime === null) {
    return responseStatus(res, 400, "failed", "Expected times must be HH:MM (24-hour) times");
  }

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
  // whatsappNumber is optional and may legitimately be cleared, so accept any
  // provided string (including "") rather than only truthy values.
  if (whatsappNumber !== undefined) updateFields.whatsappNumber = String(whatsappNumber).trim();
  if (password) updateFields.password = await hashPassword(password);
  // Expected times: only written when the request carries them (Admin/Manager
  // staff forms always do; other callers must not touch these).
  if (expectedArrivalTime !== undefined) updateFields.expectedArrivalTime = expectedArrivalTime;
  if (expectedDepartureTime !== undefined) updateFields.expectedDepartureTime = expectedDepartureTime;

  const updatedTeacher = await Teacher.findByIdAndUpdate(
    teacherId,
    { $set: updateFields },
    { new: true }
  );

  // Audit trail (fail-open): only when an expected time actually changed —
  // a credentials edit that leaves the times alone writes no audit row.
  const timeKeys = ["expectedArrivalTime", "expectedDepartureTime"];
  const beforeTimes = {
    expectedArrivalTime: teacher.expectedArrivalTime || "",
    expectedDepartureTime: teacher.expectedDepartureTime || "",
  };
  const afterTimes = {
    expectedArrivalTime: expectedArrivalTime !== undefined ? expectedArrivalTime : beforeTimes.expectedArrivalTime,
    expectedDepartureTime: expectedDepartureTime !== undefined ? expectedDepartureTime : beforeTimes.expectedDepartureTime,
  };
  const timeDiff = changedFields(beforeTimes, afterTimes, timeKeys);
  if (timeDiff) {
    const parts = [];
    if ("expectedArrivalTime" in timeDiff.before) {
      parts.push(`arrival ${timeDiff.before.expectedArrivalTime || "—"} → ${timeDiff.after.expectedArrivalTime || "—"}`);
    }
    if ("expectedDepartureTime" in timeDiff.before) {
      parts.push(`departure ${timeDiff.before.expectedDepartureTime || "—"} → ${timeDiff.after.expectedDepartureTime || "—"}`);
    }
    recordAudit({
      userId: adminId,
      actionType: "update",
      entityType: "teacher_expected_times",
      entityId: teacherId,
      summary: `Updated expected times for ${teacher.name} (${parts.join(", ")})`,
      beforeSnapshot: timeDiff.before,
      afterSnapshot: timeDiff.after,
    });
  }

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

  // Cascade cleanup: delete all Assignment records referencing this teacher
  await Assignment.deleteMany({ teacher: teacherId });

  // Cascade cleanup: null out this teacher's ID on TestResult.markedBy
  // (preserve the academic history, just remove the dangling reference)
  await TestResult.updateMany(
    { markedBy: teacherId },
    { $set: { markedBy: null } }
  );

  // Cascade cleanup: null out this teacher's ID on Attendance.markedBy
  // (preserve the attendance history, just remove the dangling reference)
  await Attendance.updateMany(
    { markedBy: teacherId },
    { $set: { markedBy: null } }
  );

  // Remove teacher reference from the admin who created it
  await Admin.findByIdAndUpdate(teacher.createdBy, {
    $pull: { teachers: teacher._id },
  });

  await Teacher.findByIdAndDelete(teacherId);

  return responseStatus(res, 200, "success", "Teacher deleted");
};
