const verifyToken = require("../utils/verifyToken");

const isLoggedIn = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      status: "failed",
      message: "No token provided",
    });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({
      status: "failed",
      message: "No token provided",
    });
  }

  const verify = verifyToken(token);
  if (verify) {
    req.userAuth = verify;
    return next();
  }

  return res.status(401).json({
    status: "failed",
    message: "Invalid or expired token",
  });
};

module.exports = isLoggedIn;
