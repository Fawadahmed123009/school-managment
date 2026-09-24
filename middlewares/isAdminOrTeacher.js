/**
 * Authorization middleware for PDF report routes.
 *
 * Only admins and teachers may generate or retrieve PDF reports.
 * Students and parents are explicitly blocked.
 */

const Admin = require("../models/Staff/admin.model");
const Teacher = require("../models/Staff/teachers.model");
const responseStatus = require("../handlers/responseStatus.handler");
const { denySuspendedApi } = require("../handlers/suspendedGate.handler");

const isAdminOrTeacher = async (req, res, next) => {
  try {
    const userId = req.userAuth?.id;
    const [admin, teacher] = await Promise.all([
      Admin.findById(userId),
      Teacher.findById(userId),
    ]);
    if (admin && admin.role === "admin") {
      return next();
    }
    if (teacher && teacher.role === "teacher") {
      // C2: suspended teachers may not generate or pull reports either.
      if (denySuspendedApi(res, teacher)) return;
      return next();
    }
    return responseStatus(res, 403, "failed", "Access Denied. Admins and teachers only!");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying access");
  }
};

module.exports = isAdminOrTeacher;
