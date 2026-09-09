const verifyToken = require("../utils/verifyToken");

const authView = async (req, res, next) => {
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

  // If the user is a teacher, check whether they are a manager so that
  // templates (sidebar, dashboard) can branch on user.isManager.
  if (session.user.role === "teacher") {
    try {
      const Teacher = require("../models/Staff/teachers.model");
      const teacher = await Teacher.findById(session.user._id).select("isAttendanceManager").lean();
      req.user.isManager = !!(teacher && teacher.isAttendanceManager);
    } catch {
      req.user.isManager = false;
    }
  }

  res.locals.user = req.user;
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

/**
 * View-route middleware: allows admin OR manager (teacher with isAttendanceManager).
 * Manager = admin minus fee/financial routes.
 */
const requireAdminOrManager = () => async (req, res, next) => {
  // Admin always passes
  if (req.user && req.user.role === "admin") return next();

  // Teacher with manager flag
  if (req.user && req.user.role === "teacher" && req.user.isManager) return next();

  return res.status(403).render("error", {
    title: "Access denied",
    message: "You don't have permission to view this page.",
    schoolName: res.locals.schoolName,
  });
};

module.exports = { authView, requireRole, requireAdminOrManager };
