/**
 * @deprecated This service uses the legacy Exam/ExamResult models.
 * TODO: Migrate to Test/TestResult models (test.model.js, testResult.model.js).
 */
const responseStatus = require("../../handlers/responseStatus.handler");
const ExamResult = require("../../models/Academic/results.model");
const Exam = require("../../models/Academic/exams.model");
const { gradeCalculate } = require("../../functions/gradeCalculate.function");
const { isTeacherAssigned } = require("./assignment.service");

exports.createMarkService = async (data, teacherId, res) => {
  const { student, exam, score } = data;

  const examFound = await Exam.findById(exam);
  if (!examFound) return responseStatus(res, 404, "failed", "Exam not found");

  // Reject scores outside the valid 0–totalMark range.
  if (typeof score !== "number" || isNaN(score) || score < 0 || score > examFound.totalMark) {
    return responseStatus(
      res,
      400,
      "failed",
      `Invalid score — must be 0–${examFound.totalMark}, got ${score}`
    );
  }

  const existing = await ExamResult.findOne({ student, exam });
  if (existing) return responseStatus(res, 400, "failed", "Mark already entered for this student/exam");

  const { grade, status, letterGrade, remarks } = gradeCalculate(
    score,
    examFound.totalMark,
    examFound.passMark
  );

  const result = await ExamResult.create({
    student,
    exam,
    teacher: teacherId,
    subject: examFound.subject,
    classLevel: examFound.classLevel,
    academicTerm: examFound.academicTerm,
    academicYear: examFound.academicYear,
    score,
    grade,
    letterGrade,
    passMark: examFound.passMark,
    status,
    remarks,
  });

  return responseStatus(res, 201, "success", result);
};

exports.bulkCreateMarksService = async (rows, teacherId, res) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return responseStatus(res, 400, "failed", "No mark rows provided");
  }

  const prepared = [];
  const skipped = [];

  // Validate every row's score before writing anything.
  const invalidRows = [];
  for (const row of rows) {
    const examFound = await Exam.findById(row.exam);
    if (!examFound) {
      skipped.push({ row, reason: "Exam not found" });
      continue;
    }
    if (typeof row.score !== "number" || isNaN(row.score) || row.score < 0 || row.score > examFound.totalMark) {
      invalidRows.push({ student: row.student, score: row.score, max: examFound.totalMark });
    }
  }
  if (invalidRows.length > 0) {
    const details = invalidRows
      .map((r) => `student ${r.student}: ${r.score} (max ${r.max})`)
      .join("; ");
    return responseStatus(
      res,
      400,
      "failed",
      `Invalid score(s) — each score must be within its exam's total. ${details}`
    );
  }

  for (const row of rows) {
    const examFound = await Exam.findById(row.exam);
    if (!examFound) continue; // already counted in skipped above

    const assigned = await isTeacherAssigned(teacherId, examFound.subject, examFound.classLevel);
    if (!assigned) {
      skipped.push({ row, reason: "Not assigned to this subject/class" });
      continue;
    }

    const { grade, status, letterGrade, remarks } = gradeCalculate(
      row.score,
      examFound.totalMark,
      examFound.passMark
    );
    prepared.push({
      student: row.student,
      exam: row.exam,
      teacher: teacherId,
      subject: examFound.subject,
      classLevel: examFound.classLevel,
      academicTerm: examFound.academicTerm,
      academicYear: examFound.academicYear,
      score: row.score,
      grade,
      letterGrade,
      passMark: examFound.passMark,
      status,
      remarks,
    });
  }

  const created = prepared.length > 0 ? await ExamResult.insertMany(prepared, { ordered: false }) : [];

  return responseStatus(res, 201, "success", { created, skipped });
};

exports.getStudentTermReportService = async (studentId, academicTermId, res) => {
  const results = await ExamResult.find({
    student: studentId,
    academicTerm: academicTermId,
  })
    .populate("subject")
    .populate("exam")
    .populate("classLevel")
    .populate("academicTerm")
    .populate("academicYear");

  if (!results.length) {
    return responseStatus(res, 404, "failed", "No results found for this student/term");
  }

  const average = results.reduce((sum, r) => sum + r.grade, 0) / results.length;
  const overall = gradeCalculate(average, 100, 50);

  return responseStatus(res, 200, "success", {
    student: studentId,
    subjects: results,
    average: Math.round(average * 100) / 100,
    overallLetterGrade: overall.letterGrade,
  });
};
