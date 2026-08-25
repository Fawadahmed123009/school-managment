const responseStatus = require("../handlers/responseStatus.handler");
const Admin = require("../models/Staff/admin.model");

const isAdmin = async (req, res, next) => {
  try {
    const userId = req.userAuth.id;
    const admin = await Admin.findById(userId);
    if (admin && admin.role === "admin") {
      return next();
    }
    return responseStatus(res, 403, "failed", "Access Denied. Admin only route!");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying admin access");
  }
};
module.exports = isAdmin;
