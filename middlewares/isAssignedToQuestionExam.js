/**
 * Question-bank assignment-scoping middleware.
 *
 * Ensures a teacher can only view/modify questions that belong to exams
 * for subjects they are actually assigned to teach.
 *
 * Supports two strategies (auto-detected per request):
 *
 *   1. req.params.examId    → load Exam directly, check (exam.subject, exam.classLevel)
 *   2. req.params.questionId → find the Exam that references this question,
 *                              then check (exam.subject, exam.classLevel)
 *
 * If neither param is present the middleware passes through so that the
 * controller / service can apply its own scoping (e.g. list all questions
 * filtered by the teacher's assigned exams).
 */

const responseStatus = require("../handlers/responseStatus.handler");
const Exam = require("../models/Academic/exams.model");
const Assignment = require("../models/Academic/assignment.model");

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── API middleware ────────────────────────────────────────────────────────────

const isAssignedToQuestionExam = async (req, res, next) => {
  try {
    const teacherId = req.userAuth?.id;
    if (!teacherId) {
      return responseStatus(res, 401, "failed", "Authentication required");
    }

    let exam = null;

    // ── Strategy 1: examId in route params (POST /questions/:examId/create) ─
    if (req.params.examId) {
      exam = await Exam.findById(req.params.examId);
      if (!exam) {
        return responseStatus(res, 404, "failed", "Exam not found");
      }
    }

    // ── Strategy 2: questionId in route params (GET/PATCH /question/:questionId) ─
    if (!exam && req.params.questionId) {
      exam = await Exam.findOne({ questions: req.params.questionId });
      if (!exam) {
        return responseStatus(res, 404, "failed", "Question not found in any exam");
      }
    }

    // ── No exam context → pass through (let controller/service handle it) ────
    if (!exam) {
      return next();
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
  } catch (err) {
    return responseStatus(res, 500, "failed", "Server error verifying subject assignment");
  }
};

module.exports = isAssignedToQuestionExam;
