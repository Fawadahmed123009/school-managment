const responseStatus = require("../handlers/responseStatus.handler");
const Teacher = require("../models/Staff/teachers.model");

const isTeacher = async (req, res, next) => {
  try {
    const userId = req.userAuth.id;
    const teacher = await Teacher.findById(userId);
    if (teacher?.role === "teacher") {
      return next();
    }
    return responseStatus(res, 403, "failed", "Access Denied. Teachers only route!");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying teacher access");
  }
};
module.exports = isTeacher;
