/**
 * Teacher subject-assignment authorization middleware.
 *
 * Verifies that the logged-in teacher is assigned (via the Assignment model)
 * to the subject + class of the resource being accessed.
 *
 * Supports multiple data-source strategies (auto-detected per request):
 *
 *   1. req.params.testId  →  loads Test, checks (test.subject, each test.classLevel)
 *   2. req.body.marks[]   →  loads each legacy Exam by exam id (bulk legacy route)
 *   3. req.body.exam      →  loads legacy Exam (single legacy mark route)
 *
 * For test-based routes the teacher must be assigned to the test's subject for
 * AT LEAST ONE of the test's class levels.  For legacy exam routes the teacher
 * must be assigned to the exact (subject, classLevel) pair.
 *
 * Existing service-level checks are kept as defense-in-depth; this middleware
 * is the primary gate that rejects unauthorised requests before they reach
 * business logic.
 */

const responseStatus = require("../handlers/responseStatus.handler");
const Test = require("../models/Academic/test.model");
const Exam = require("../models/Academic/exams.model");
const Assignment = require("../models/Academic/assignment.model");

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when the teacher has at least one Assignment record that
 * matches `subjectId` and one of the `classLevelIds`.
 */
async function teacherMatchesAnyAssignment(teacherId, subjectId, classLevelIds) {
  const ids = Array.isArray(classLevelIds) ? classLevelIds : [classLevelIds];
  for (const classId of ids) {
    const found = await Assignment.findOne({
      teacher: teacherId,
      subject: subjectId,
      classLevel: classId,
    });
    if (found) return true;
  }
  return false;
}

// ── API middleware (Bearer-token routes) ─────────────────────────────────────

/**
 * Express middleware for API routes (uses req.userAuth.id from JWT).
 *
 * Auto-detects what to check:
 *   • req.params.testId present  → Test-based check
 *   • req.body.marks[] present   → Legacy bulk-exam check (every exam in array)
 *   • req.body.exam present      → Legacy single-exam check
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

    // ── Strategy 2: Legacy bulk marks — req.body.marks[].exam ─────────────
    if (req.body.marks && Array.isArray(req.body.marks)) {
      const examIds = [
        ...new Set(
          req.body.marks
            .map((m) => m.exam)
            .filter(Boolean)
        ),
      ];

      if (examIds.length === 0) {
        return responseStatus(res, 400, "failed", "No exam references found in marks data");
      }

      for (const examId of examIds) {
        const exam = await Exam.findById(examId);
        if (!exam) {
          return responseStatus(res, 404, "failed", `Exam ${examId} not found`);
        }
        const ok = await teacherMatchesAnyAssignment(
          teacherId,
          exam.subject,
          exam.classLevel
        );
        if (!ok) {
          return responseStatus(
            res,
            403,
            "failed",
            `You are not assigned to teach "${exam.name}" for its class`
          );
        }
      }
      return next();
    }

    // ── Strategy 3: Legacy single mark — req.body.exam ────────────────────
    if (req.body.exam) {
      const exam = await Exam.findById(req.body.exam);
      if (!exam) {
        return responseStatus(res, 404, "failed", "Exam not found");
      }

      const ok = await teacherMatchesAnyAssignment(
        teacherId,
        exam.subject,
        exam.classLevel
      );
      if (!ok) {
        return responseStatus(
          res,
          403,
          "failed",
          "You are not assigned to teach this subject for this class"
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
