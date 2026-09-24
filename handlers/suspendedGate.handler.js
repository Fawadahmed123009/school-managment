const responseStatus = require("./responseStatus.handler");

/**
 * Single definition of what "suspended" means for a teacher (C2).
 *
 * A suspended teacher may still sign in (per models/Staff/teachers.model.js)
 * but must not perform any task. That is only true if the flag is re-read from
 * the database on EVERY request: the session cookie and the bearer token carry
 * no suspension information and stay valid for their whole lifetime, so
 * without a per-request re-check suspending a teacher would take effect only
 * the next time they happened to log in.
 *
 * These helpers are used by the API role middlewares (Bearer token) and by the
 * view-route role guards (signed session cookie), so both halves of the app
 * answer identically.
 */
const SUSPENDED_MESSAGE =
  "Access Denied. Your account is suspended — contact the administrator.";

/**
 * API guard. Returns true when the request was rejected (response written).
 * @param {Object} res     – express response
 * @param {Object|null} teacher – teacher document already loaded by the caller
 */
const denySuspendedApi = (res, teacher) => {
  if (teacher && teacher.isSuspended) {
    responseStatus(res, 403, "failed", SUSPENDED_MESSAGE);
    return true;
  }
  return false;
};

/**
 * View-route guard. Returns true when the request was rejected (page rendered).
 * Reads req.user.isSuspended, which middlewares/authView.js derives from the
 * database on every request.
 */
const denySuspendedView = (req, res) => {
  if (req.user && req.user.isSuspended) {
    res.status(403).render("error", {
      title: "Account suspended",
      message: SUSPENDED_MESSAGE,
      schoolName: res.locals.schoolName,
    });
    return true;
  }
  return false;
};

module.exports = { SUSPENDED_MESSAGE, denySuspendedApi, denySuspendedView };
