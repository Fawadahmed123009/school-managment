const Admin = require("../models/Staff/admin.model");
const Teacher = require("../models/Staff/teachers.model");
const responseStatus = require("../handlers/responseStatus.handler");

/**
 * Authorization middleware for API routes (Bearer-token).
 * Allows both full admins and managers (teachers with isAttendanceManager).
 * Manager = admin minus fee/financial routes.
 */
const isAdminOrManager = async (req, res, next) => {
  try {
    const userId = req.userAuth.id;
    const [admin, teacher] = await Promise.all([
      Admin.findById(userId),
      Teacher.findById(userId),
    ]);
    if ((admin && admin.role === "admin") || (teacher && teacher.isAttendanceManager)) {
      return next();
    }
    return responseStatus(res, 403, "failed", "Access Denied. Admin or manager only route.");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying access");
  }
};

module.exports = isAdminOrManager;
