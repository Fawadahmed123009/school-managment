/**
 * Teacher subject-assignment authorization middleware.
 *
 * Verifies that the logged-in teacher is assigned (via the Assignment model)
 * to the subject + class of the Test being accessed.
 *
 * The legacy manual mark-entry routes (POST /marks and POST /marks/bulk, which
 * gated on req.body.exam / req.body.marks[]) have been retired, so the only
 * supported strategy is:
 *
 *   1. req.params.testId  →  loads Test, checks (test.subject, each test.classLevel)
 *
 * For test-based routes the teacher must be assigned to the test's subject for
 * AT LEAST ONE of the test's class levels.
 *
 * Existing service-level checks are kept as defense-in-depth; this middleware
 * is the primary gate that rejects unauthorised requests before they reach
 * business logic.
 */

const responseStatus = require("../handlers/responseStatus.handler");
const { denySuspendedApi } = require("../handlers/suspendedGate.handler");
const Test = require("../models/Academic/test.model");
const Assignment = require("../models/Academic/assignment.model");

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when the teacher has at least one Assignment record that
 * matches `subjectId` and one of the `classLevelIds`.
 *
 * Single round-trip: all class levels are checked in one query via `$in`
 * (the compound index on { teacher, subject, classLevel } covers it).
 * Falls back to false for an empty/undefined class-level list, matching the
 * old per-iteration loop's behavior.
 */
async function teacherMatchesAnyAssignment(teacherId, subjectId, classLevelIds) {
  const ids = (Array.isArray(classLevelIds) ? classLevelIds : [classLevelIds])
    .filter((id) => id !== undefined && id !== null);
  if (ids.length === 0) return false;
  const found = await Assignment.findOne({
    teacher: teacherId,
    subject: subjectId,
    classLevel: { $in: ids },
  });
  return Boolean(found);
}

// ── API middleware (Bearer-token routes) ─────────────────────────────────────

/**
 * Express middleware for API routes (uses req.userAuth.id from JWT).
 *
 * Checks:
 *   • req.params.testId present  → Test-based assignment check
 *   • otherwise                  → passes through (let service handle it)
 */
const isAssignedToSubject = async (req, res, next) => {
  try {
    const teacherId = req.userAuth?.id;
    if (!teacherId) {
      return responseStatus(res, 401, "failed", "Authentication required");
    }

    // ── Strategy 1: Test by testId (route param) ─────────────────────────
    if (req.params.testId) {
      const test = await Test.findById(req.params.testId);
      if (!test) {
        return responseStatus(res, 404, "failed", "Test not found");
      }

      const ok = await teacherMatchesAnyAssignment(
        teacherId,
        test.subject,
        test.classLevels
      );
      if (!ok) {
        return responseStatus(
          res,
          403,
          "failed",
          "You are not assigned to teach this subject for any class in this test"
        );
      }
      return next();
    }

    // ── No identifiable resource → pass through ───────────────────────────
    // The controller / service is expected to handle validation.
    next();
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying subject assignment");
  }
};

// ── View-route middleware (cookie-session auth) ──────────────────────────────

/**
 * Express middleware for server-rendered view routes (uses req.user from
 * session cookie).  Checks that a teacher is assigned to the test identified
 * by req.params.testId.
 */
const isAssignedToTestView = async (req, res, next) => {
  try {
    const teacherId = req.user?._id;
    if (!teacherId) {
      return res.redirect("/login");
    }

    // C2: suspension is re-read here as well, so the manager bypass below can
    // never be reached by a suspended teacher (req.user.isSuspended is
    // DB-derived, set by middlewares/authView.js on every request).
    if (denySuspendedApi(res, { isSuspended: req.user.isSuspended })) return;

    // Manager bypass: managers can mark ANY test without subject-assignment check
    const Teacher = require("../models/Staff/teachers.model");
    const teacher = await Teacher.findById(teacherId).select("isAttendanceManager").lean();
    if (teacher && teacher.isAttendanceManager) return next();

    const { testId } = req.params;
    if (!testId) {
      return next(); // no test context → let the route handle it
    }

    const test = await Test.findById(testId);
    if (!test) {
      return res.status(404).render("error", {
        title: "Not found",
        message: "The test you are looking for does not exist.",
        schoolName: res.locals.schoolName,
      });
    }

    const ok = await teacherMatchesAnyAssignment(
      teacherId,
      test.subject,
      test.classLevels
    );
    if (!ok) {
      return res.status(403).render("error", {
        title: "Access denied",
        message:
          "You are not assigned to teach this subject for any class in this test.",
        schoolName: res.locals.schoolName,
      });
    }

    next();
  } catch (err) {
    return res.status(500).render("error", {
      title: "Server error",
      message: "Could not verify your subject assignment.",
      schoolName: res.locals.schoolName,
    });
  }
};

module.exports = isAssignedToSubject;
module.exports.isAssignedToTestView = isAssignedToTestView;
