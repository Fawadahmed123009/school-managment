const responseStatus = require("../handlers/responseStatus.handler");
const Student = require("../models/Students/students.model");

const isStudent = async (req, res, next) => {
  try {
    const userId = req.userAuth.id;
    const student = await Student.findById(userId);
    if (student?.role === "student") {
      return next();
    }
    return responseStatus(res, 403, "failed", "Access Denied. Students only route!");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying student access");
  }
};
module.exports = isStudent;
