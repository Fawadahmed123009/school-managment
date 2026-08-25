const responseStatus = require("../handlers/responseStatus.handler");
const Parent = require("../models/Parents/parents.model");

const isParent = async (req, res, next) => {
  try {
    const userId = req.userAuth.id;
    const parent = await Parent.findById(userId);
    if (parent?.role === "parent") {
      return next();
    }
    return responseStatus(res, 403, "failed", "Access Denied. Parents only route!");
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying parent access");
  }
};
module.exports = isParent;
