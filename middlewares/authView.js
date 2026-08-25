const verifyToken = require("../utils/verifyToken");

const authView = (req, res, next) => {
  const raw = req.cookies && req.cookies.session;
  if (!raw) return res.redirect("/login");

  let session;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    return res.redirect("/login");
  }

  const verified = verifyToken(session.token);
  if (!verified) return res.redirect("/login");

  req.user = session.user;
  req.token = session.token;
  res.locals.user = session.user;
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).render("error", {
      title: "Access denied",
      message: "You don't have permission to view this page.",
      schoolName: res.locals.schoolName,
    });
  }
  next();
};

module.exports = { authView, requireRole };
