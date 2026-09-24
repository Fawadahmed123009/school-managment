const responseStatus = require("../handlers/responseStatus.handler");
const Teacher = require("../models/Staff/teachers.model");
const { denySuspendedApi } = require("../handlers/suspendedGate.handler");

const isTeacher = async (req, res, next) => {
  try {
    const userId = req.userAuth.id;
    const teacher = await Teacher.findById(userId);
    if (teacher?.role === "teacher") {
      // C2: status is re-read per request, so suspending a teacher takes
      // effect immediately instead of when their token next expires.
      if (denySuspendedApi(res, teacher)) return;
      return next();
    }
    return responseStatus(res, 403, "failed", "Access Denied. Teachers only route!");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying teacher access");
  }
};
module.exports = isTeacher;
