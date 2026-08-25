const responseStatus = require("../handlers/responseStatus.handler");
const Teacher = require("../models/Staff/teachers.model");

const isAttendanceManager = async (req, res, next) => {
  try {
    const teacherId = req.userAuth.id;
    const teacher = await Teacher.findById(teacherId);
    if (teacher && teacher.isAttendanceManager) {
      return next();
    }
    return responseStatus(res, 403, "failed", "Access Denied. Attendance manager only.");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying attendance manager access");
  }
};

module.exports = isAttendanceManager;
