const verifyToken = require("../utils/verifyToken");

// Resolve a user's authoritative role/manager flag from the DATABASE, keyed off
// the *verified* JWT id. Two layers protect identity here:
//   1. The `session` cookie is SIGNED (cookieParser(COOKIE_SECRET)). A cookie
//      whose signature does not match is never surfaced on req.signedCookies,
//      so a client cannot edit the stored `user`/`role` fields without the
//      signature breaking — a tampered cookie is treated exactly like no
//      session (redirect to /login), not a soft warning.
//   2. Even with a valid signature, the `session.user` object is only trusted
//      for non-security display fields (name etc.). The authoritative role and
//      isManager flag are resolved from the DB below, keyed off the verified
//      JWT id — so identity can never be escalated from cookie contents alone.
// Returns { role, isManager } or null when the id matches no known user.
async function resolveIdentityFromDb(id) {
  if (!id) return null;
  const Admin = require("../models/Staff/admin.model");
  const Teacher = require("../models/Staff/teachers.model");
  const Student = require("../models/Students/students.model");
  const Parent = require("../models/Parents/parents.model");

  const admin = await Admin.findById(id).select("role").lean();
  if (admin) return { role: admin.role || "admin", isManager: false };

  const teacher = await Teacher.findById(id).select("role isAttendanceManager").lean();
  if (teacher) return { role: teacher.role || "teacher", isManager: !!teacher.isAttendanceManager };

  const student = await Student.findById(id).select("role").lean();
  if (student) return { role: student.role || "student", isManager: false };

  const parent = await Parent.findById(id).select("role").lean();
  if (parent) return { role: parent.role || "parent", isManager: false };

  return null;
}

const authView = async (req, res, next) => {
  // req.signedCookies.session is only populated by cookie-parser when the
  // cookie's signature verifies against COOKIE_SECRET. A forged, edited, or
  // tampered cookie (and any pre-signing legacy cookie) is absent here, so it
  // is treated the same as having no session at all.
  const raw = req.signedCookies && req.signedCookies.session;
  if (!raw) return res.redirect("/login");

  let session;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    return res.redirect("/login");
  }

  const verified = verifyToken(session.token);
  if (!verified) return res.redirect("/login");

  // Authoritative identity is the verified token id, resolved against the DB —
  // never the (unsigned, editable) session.user object.
  const identity = await resolveIdentityFromDb(verified.id);
  if (!identity) return res.redirect("/login");

  // Keep cookie-supplied display fields (name etc.) but override every
  // security-relevant field with DB-derived truth.
  req.user = {
    ...(session.user || {}),
    _id: verified.id,
    id: verified.id,
    role: identity.role,
    isManager: identity.isManager,
  };
  req.token = session.token;

  res.locals.user = req.user;
  res.locals.authToken = req.token;
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
