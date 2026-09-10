/**
 * At-Risk Student Alerts Service
 *
 * Identifies students with low attendance (< 75%) or low per-subject test
 * averages (< 40%).  Two entry-points:
 *
 *   • getAtRiskStudentsAdmin(classLevelId?) — school-wide, optional class filter
 *   • getAtRiskStudentsTeacher(teacherId)   — scoped to teacher's classes and
 *                                              only their assigned subjects
 *
 * Attendance % reuses the existing convention: (present + late) / totalMarked,
 * over ALL available records (auto-capped at ~90 days by the TTL index on the
 * Attendance collection).  Score % per subject: average of (score / totalMarks)
 * across every test in that subject, regardless of session.
 */

const Attendance = require("../../models/Academic/attendance.model");
const TestResult = require("../../models/Academic/testResult.model");
const Student = require("../../models/Students/students.model");
const Assignment = require("../../models/Academic/assignment.model");

// ── Configurable thresholds (hardcode sensible defaults for now) ────────────
const ATTENDANCE_THRESHOLD = 75; // percent — flag students below this
const SCORE_THRESHOLD = 40;      // percent — flag per-subject averages below this
const MAX_LIST_SIZE = 10;        // cap for dashboard panels

// ── Admin / Manager ─────────────────────────────────────────────────────────
// Returns up to MAX_LIST_SIZE at-risk students school-wide, with reasons.
// If classLevelId is provided, filters to that class only.
exports.getAtRiskStudentsAdmin = async (classLevelId) => {
  // 1. Attendance % per student via aggregation
  const attAgg = await Attendance.aggregate([
    {
      $group: {
        _id: "$student",
        present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
        late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
      },
    },
  ]);

  // 2. Test results with subject info, scoped to active students' classes
  const studentFilter = { isWithdrawn: { $ne: true }, status: { $ne: "inactive" } };
  if (classLevelId) studentFilter.classLevel = classLevelId;

  const students = await Student.find(studentFilter)
    .select("_id name studentId rollNumber classLevel")
    .populate("classLevel", "name gradeLevel group section")
    .sort("name")
    .lean();

  if (students.length === 0) return { students: [], total: 0, hasMore: false };

  const studentIds = students.map((s) => s._id);

  const testResults = await TestResult.find({ student: { $in: studentIds } })
    .populate({
      path: "test",
      populate: [{ path: "subject", select: "name" }],
    })
    .lean();

  // 3. Build lookup maps
  const attMap = {};
  attAgg.forEach((a) => { attMap[a._id.toString()] = a; });

  // 4. Evaluate each student
  const atRisk = [];

  for (const student of students) {
    const reasons = [];
    const sid = student._id.toString();

    // Attendance check
    const att = attMap[sid];
    let attPercent = null;
    if (att) {
      const total = att.present + att.absent + att.late;
      if (total > 0) {
        attPercent = Math.round(((att.present + att.late) / total) * 10000) / 100;
        if (attPercent < ATTENDANCE_THRESHOLD) {
          reasons.push({
            type: "attendance",
            message: `${attPercent}% attendance`,
            value: attPercent,
          });
        }
      }
    }

    // Per-subject score check
    const subjectAgg = {};
    testResults
      .filter((r) => r.student.toString() === sid && r.test && r.test.totalMarks)
      .forEach((r) => {
        const subjectName = r.test.subject ? r.test.subject.name : "Unknown";
        const percent = Math.round((r.score / r.test.totalMarks) * 10000) / 100;
        if (!subjectAgg[subjectName]) subjectAgg[subjectName] = { total: 0, count: 0 };
        subjectAgg[subjectName].total += percent;
        subjectAgg[subjectName].count += 1;
      });

    const lowSubjects = Object.keys(subjectAgg)
      .map((subject) => {
        const avg = Math.round((subjectAgg[subject].total / subjectAgg[subject].count) * 100) / 100;
        return { subject, average: avg };
      })
      .filter((s) => s.average < SCORE_THRESHOLD)
      .sort((a, b) => a.average - b.average);

    lowSubjects.forEach((s) => {
      reasons.push({
        type: "score",
        message: `${s.average}% avg in ${s.subject}`,
        value: s.average,
        subject: s.subject,
      });
    });

    if (reasons.length > 0) {
      atRisk.push({
        student: {
          _id: student._id,
          name: student.name,
          studentId: student.studentId,
          rollNumber: student.rollNumber,
          className: student.classLevel ? student.classLevel.name : "—",
        },
        attendancePercent: attPercent,
        reasons,
      });
    }
  }

  // Sort: lowest attendance first, then most low-subjects
  atRisk.sort((a, b) => {
    const aAtt = a.attendancePercent !== null ? a.attendancePercent : 100;
    const bAtt = b.attendancePercent !== null ? b.attendancePercent : 100;
    if (aAtt !== bAtt) return aAtt - bAtt;
    return b.reasons.length - a.reasons.length;
  });

  return {
    students: atRisk.slice(0, MAX_LIST_SIZE),
    total: atRisk.length,
    hasMore: atRisk.length > MAX_LIST_SIZE,
  };
};

// ── Teacher ─────────────────────────────────────────────────────────────────
// Scoped to teacher's assigned classes (attendance) and only their subjects
// (scores). A Math teacher won't see students flagged for Chemistry.
exports.getAtRiskStudentsTeacher = async (teacherId) => {
  // 1. Teacher's assignments → subjects & classes
  const assignments = await Assignment.find({ teacher: teacherId })
    .populate("subject", "name")
    .populate("classLevel", "name gradeLevel group section")
    .lean();

  if (assignments.length === 0) return { students: [], total: 0, hasMore: false };

  const subjectIdSet = new Set();
  const subjectNames = new Set();
  const classLevelIds = [];

  assignments.forEach((a) => {
    if (a.subject) {
      subjectIdSet.add(a.subject._id.toString());
      subjectNames.add(a.subject.name);
    }
    if (a.classLevel) classLevelIds.push(a.classLevel._id);
  });

  if (classLevelIds.length === 0) return { students: [], total: 0, hasMore: false };

  // 2. Attendance for students in teacher's classes
  const attAgg = await Attendance.aggregate([
    { $match: { classLevel: { $in: classLevelIds } } },
    {
      $group: {
        _id: "$student",
        present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
        absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
        late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
      },
    },
  ]);

  // 3. Students in teacher's classes
  const students = await Student.find({
    classLevel: { $in: classLevelIds },
    isWithdrawn: { $ne: true },
  })
    .select("_id name studentId rollNumber classLevel")
    .populate("classLevel", "name gradeLevel group section")
    .sort("name")
    .lean();

  if (students.length === 0) return { students: [], total: 0, hasMore: false };

  const studentIds = students.map((s) => s._id);

  // 4. Test results — only for teacher's subjects
  const testResults = await TestResult.find({ student: { $in: studentIds } })
    .populate({
      path: "test",
      populate: [{ path: "subject", select: "name" }],
    })
    .lean();

  // Filter to only teacher's subjects
  const filteredResults = testResults.filter((r) => {
    if (!r.test || !r.test.subject) return false;
    return subjectIdSet.has(r.test.subject._id.toString());
  });

  // 5. Build lookup maps
  const attMap = {};
  attAgg.forEach((a) => { attMap[a._id.toString()] = a; });

  // 6. Evaluate each student
  const atRisk = [];

  for (const student of students) {
    const reasons = [];
    const sid = student._id.toString();

    // Attendance check (scoped to teacher's classes)
    const att = attMap[sid];
    let attPercent = null;
    if (att) {
      const total = att.present + att.absent + att.late;
      if (total > 0) {
        attPercent = Math.round(((att.present + att.late) / total) * 10000) / 100;
        if (attPercent < ATTENDANCE_THRESHOLD) {
          reasons.push({
            type: "attendance",
            message: `${attPercent}% attendance`,
            value: attPercent,
          });
        }
      }
    }

    // Per-subject score check — ONLY teacher's subjects
    const subjectAgg = {};
    filteredResults
      .filter((r) => r.student.toString() === sid && r.test && r.test.totalMarks)
      .forEach((r) => {
        const subjectName = r.test.subject ? r.test.subject.name : "Unknown";
        const percent = Math.round((r.score / r.test.totalMarks) * 10000) / 100;
        if (!subjectAgg[subjectName]) subjectAgg[subjectName] = { total: 0, count: 0 };
        subjectAgg[subjectName].total += percent;
        subjectAgg[subjectName].count += 1;
      });

    const lowSubjects = Object.keys(subjectAgg)
      .map((subject) => {
        const avg = Math.round((subjectAgg[subject].total / subjectAgg[subject].count) * 100) / 100;
        return { subject, average: avg };
      })
      .filter((s) => s.average < SCORE_THRESHOLD)
      .sort((a, b) => a.average - b.average);

    lowSubjects.forEach((s) => {
      reasons.push({
        type: "score",
        message: `${s.average}% avg in ${s.subject}`,
        value: s.average,
        subject: s.subject,
      });
    });

    if (reasons.length > 0) {
      atRisk.push({
        student: {
          _id: student._id,
          name: student.name,
          studentId: student.studentId,
          rollNumber: student.rollNumber,
          className: student.classLevel ? student.classLevel.name : "—",
        },
        attendancePercent: attPercent,
        reasons,
      });
    }
  }

  // Sort: lowest attendance first, then most low-subjects
  atRisk.sort((a, b) => {
    const aAtt = a.attendancePercent !== null ? a.attendancePercent : 100;
    const bAtt = b.attendancePercent !== null ? b.attendancePercent : 100;
    if (aAtt !== bAtt) return aAtt - bAtt;
    return b.reasons.length - a.reasons.length;
  });

  return {
    students: atRisk.slice(0, MAX_LIST_SIZE),
    total: atRisk.length,
    hasMore: atRisk.length > MAX_LIST_SIZE,
  };
};

// Export thresholds for use in views (so EJS can check the same values)
exports.THRESHOLDS = { ATTENDANCE: ATTENDANCE_THRESHOLD, SCORE: SCORE_THRESHOLD };
