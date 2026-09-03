const responseStatus = require("../../handlers/responseStatus.handler");
const Student = require("../../models/Students/students.model");
const Attendance = require("../../models/Academic/attendance.model");
const TestResult = require("../../models/Academic/testResult.model");
const Fees = require("../../models/Fees/fees.model");

exports.getStudentAnalysisService = async (studentId, res) => {
  const student = await Student.findById(studentId).populate("classLevel", "name gradeLevel group section");
  if (!student) return responseStatus(res, 404, "failed", "Student not found");

  // ---- Attendance ----
  const attendanceRecords = await Attendance.find({ student: studentId });
  const attendanceTotals = { present: 0, absent: 0, late: 0 };
  attendanceRecords.forEach((r) => { attendanceTotals[r.status]++; });
  const totalMarked = attendanceRecords.length;
  const attendancePercent = totalMarked > 0
    ? Math.round(((attendanceTotals.present + attendanceTotals.late) / totalMarked) * 10000) / 100
    : null;

  // ---- Test results, grouped by session ----
  const testResults = await TestResult.find({ student: studentId })
    .populate({
      path: "test",
      populate: [
        { path: "subject", select: "name" },
        { path: "session", select: "name" },
      ],
    });

  // Group by session name (or "Standalone tests" for tests with no session).
  // Same pattern as the session report card: results keyed by session, each
  // row carries score/totalMarks/percent like the analytics endpoint.
  const bySession = {};
  testResults.forEach((r) => {
    const test = r.test;
    if (!test) return; // orphaned result (test deleted)

    const sessionName = test.session ? test.session.name : "Standalone tests";
    if (!bySession[sessionName]) bySession[sessionName] = [];

    const percent = test.totalMarks
      ? Math.round((r.score / test.totalMarks) * 10000) / 100
      : null;

    bySession[sessionName].push({
      test: test.name,
      subject: test.subject ? test.subject.name : "Unknown",
      date: test.date,
      score: r.score,
      totalMarks: test.totalMarks,
      percent,
    });
  });

  // Sort each group's tests by date (ascending) + compute per-session average
  const sessionSummaries = Object.keys(bySession).map((sessionName) => {
    const tests = bySession[sessionName].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    const validPercents = tests.filter((t) => t.percent !== null);
    const average =
      validPercents.length > 0
        ? Math.round(
            (validPercents.reduce((sum, t) => sum + t.percent, 0) /
              validPercents.length) *
              100
          ) / 100
        : null;
    return { session: sessionName, tests, average };
  });

  const allPercents = testResults
    .filter((r) => r.test && r.test.totalMarks)
    .map((r) => Math.round((r.score / r.test.totalMarks) * 10000) / 100);
  const overallAverage =
    allPercents.length > 0
      ? Math.round(
          (allPercents.reduce((sum, p) => sum + p, 0) / allPercents.length) * 100
        ) / 100
      : null;

  // ---- Subject-wise aggregation (average % per subject, across all sessions) ----
  // The per-session tables list each test as a raw row, so a subject repeats
  // across rows. Roll those up here so the UI can show one average per subject
  // instead of a flat, repeating column.
  const subjectAgg = {};
  testResults.forEach((r) => {
    const test = r.test;
    if (!test || !test.totalMarks) return;
    const subjectName = test.subject ? test.subject.name : "Unknown";
    const percent = Math.round((r.score / test.totalMarks) * 10000) / 100;
    if (!subjectAgg[subjectName]) subjectAgg[subjectName] = { total: 0, count: 0 };
    subjectAgg[subjectName].total += percent;
    subjectAgg[subjectName].count += 1;
  });
  const bySubject = Object.keys(subjectAgg)
    .map((subject) => ({
      subject,
      count: subjectAgg[subject].count,
      average:
        Math.round((subjectAgg[subject].total / subjectAgg[subject].count) * 100) / 100,
    }))
    .sort((a, b) => b.average - a.average);

  // ---- Progress series (per-session average %, ordered chronologically) ----
  // The per-session averages above are only surfaced as pills today; expose them
  // as a time-ordered series so the UI can plot a progress trend chart.
  const progress = sessionSummaries
    .filter((s) => s.average !== null)
    .map((s) => ({
      session: s.session,
      average: s.average,
      // tests within a session are sorted ascending by date, so [0] is earliest
      date: s.tests.length ? s.tests[0].date : null,
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // ---- Fees ----
  const feeRecords = await Fees.find({ student: studentId });
  const feeTotals = { total: 0, paid: 0, pending: 0 };
  feeRecords.forEach((f) => {
    feeTotals.total += f.amount;
    if (f.status === "paid") feeTotals.paid += f.amount;
    else feeTotals.pending += f.amount;
  });

  return responseStatus(res, 200, "success", {
    student: {
      _id: student._id,
      name: student.name,
      studentId: student.studentId,
      classLevel: student.classLevel,
      photoUrl: student.photoUrl,
    },
    attendance: {
      totalMarked,
      ...attendanceTotals,
      percent: attendancePercent,
    },
    marks: {
      overallAverage,
      bySession: sessionSummaries,
      bySubject,
      progress,
    },
    fees: {
      ...feeTotals,
      records: feeRecords,
    },
  });
};
