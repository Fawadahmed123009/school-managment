/**
 * At-Risk Student Alerts Service
 *
 * Two entry-points with DIFFERENT criteria on purpose:
 *
 *   • getAtRiskStudentsAdmin(classLevelId?, sortBy?, gradeLevel?, options?) —
 *     school-wide, optional class filter and/or grade-level filter. The
 *     dashboard no longer re-queries per grade: it passes options.maxList =
 *     null to get the FULL ranked list (with each student's gradeLevel) and
 *     buckets it per grade tab itself, so tab clicks are client-side only.
 *     Flags on MARKS ONLY: any subject average < 40 %. Attendance % is still
 *     computed and returned for DISPLAY (the panel's "Att %" column mirrors
 *     the Top Performers layout) but never triggers a flag by itself.
 *   • getAtRiskStudentsTeacher(teacherId)   — scoped to teacher's classes and
 *                                              only their assigned subjects;
 *                                              keeps the original attendance
 *                                              + marks criteria unchanged.
 *
 * Attendance % reuses the existing convention: (present + late) / totalMarked,
 * over ALL available attendance records for the student (the Attendance
 * collection retains full history — the old ~90-day TTL index was deliberately
 * removed earlier in this project, so there is no auto-cap).
 * Score % per subject: average of (score / totalMarks)
 * across every test in that subject, regardless of session.
 *
 * Student eligibility (which students are considered at all) is IDENTICAL for
 * both entry-points: withdrawn and inactive students are excluded from the
 * admin and teacher panels alike, so the two views agree on the population.
 */

const Attendance = require("../../models/Academic/attendance.model");
const TestResult = require("../../models/Academic/testResult.model");
const Student = require("../../models/Students/students.model");
const Assignment = require("../../models/Academic/assignment.model");
const ClassLevel = require("../../models/Academic/class.model");

// ── Configurable thresholds (hardcode sensible defaults for now) ────────────
const ATTENDANCE_THRESHOLD = 75; // percent — teacher panel flags below this (admin panel is marks-only)
const SCORE_THRESHOLD = 40;      // percent — flag per-subject averages below this
const MAX_LIST_SIZE = 10;        // cap for dashboard panels

// ── Admin / Manager ─────────────────────────────────────────────────────────
// Returns up to MAX_LIST_SIZE at-risk students school-wide, ranked by LOWEST
// marks average — the panel mirrors Top Performers (avg % + Att % per row).
// Flagging is MARKS-ONLY: at least one subject average below SCORE_THRESHOLD;
// attendance % is returned for display but never flags on its own.
// If classLevelId is provided, filters to that class only. gradeLevel ("9"…"12")
// restricts to every class at that grade (kept for API compatibility — the
// dashboard now fetches the full list once and buckets per grade itself).
// options.maxList overrides the 10-row panel cap; pass null for the FULL
// sorted list (the dashboard's client-side grade tabs need every bucket).
exports.getAtRiskStudentsAdmin = async (classLevelId, sortBy, gradeLevel, options) => {
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
  if (gradeLevel) {
    const gradeClasses = await ClassLevel.find({ gradeLevel }).select("_id").lean();
    let gradeIds = gradeClasses.map((c) => String(c._id));
    if (classLevelId) gradeIds = gradeIds.filter((id) => id === String(classLevelId));
    studentFilter.classLevel = { $in: gradeIds };
  } else if (classLevelId) {
    studentFilter.classLevel = classLevelId;
  }

  const students = await Student.find(studentFilter)
    .select("_id name studentId rollNumber classLevel parent fatherName")
    .populate("classLevel", "name gradeLevel group section")
    .populate("parent", "name")
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

  // 4. Evaluate each student — flags are MARKS-ONLY on this path
  const atRisk = [];

  for (const student of students) {
    const sid = student._id.toString();

    // Attendance: display-only here ("Att %" column) — never triggers a flag.
    const att = attMap[sid];
    let attPercent = null;
    if (att) {
      const total = att.present + att.absent + att.late;
      if (total > 0) {
        attPercent = Math.round(((att.present + att.late) / total) * 10000) / 100;
      }
    }

    // Per-subject score check + overall average (same per-test convention as
    // the Top Performers ranking, so the two panels' numbers are comparable).
    const subjectAgg = {};
    let pctSum = 0;
    let pctCount = 0;
    testResults
      .filter((r) => r.student.toString() === sid && r.test && r.test.totalMarks && r.absent !== true && r.score > 0)
      .forEach((r) => {
        const subjectName = r.test.subject ? r.test.subject.name : "Unknown";
        const percent = Math.round((r.score / r.test.totalMarks) * 10000) / 100;
        if (!subjectAgg[subjectName]) subjectAgg[subjectName] = { total: 0, count: 0 };
        subjectAgg[subjectName].total += percent;
        subjectAgg[subjectName].count += 1;
        pctSum += percent;
        pctCount += 1;
      });

    const lowSubjects = Object.keys(subjectAgg)
      .map((subject) => {
        const avg = Math.round((subjectAgg[subject].total / subjectAgg[subject].count) * 100) / 100;
        return { subject, average: avg };
      })
      .filter((s) => s.average < SCORE_THRESHOLD)
      .sort((a, b) => a.average - b.average);

    // A student is at-risk here ONLY through low subject averages.
    if (lowSubjects.length === 0) continue;

    const reasons = lowSubjects.map((s) => ({
      type: "score",
      message: `${s.average}% avg in ${s.subject}`,
      value: s.average,
      subject: s.subject,
    }));

    atRisk.push({
      student: {
        _id: student._id,
        name: student.name,
        studentId: student.studentId,
        rollNumber: student.rollNumber,
        className: student.classLevel ? student.classLevel.name : "—",
        // Grade drives the dashboard's client-side grade-tab bucketing.
        gradeLevel: student.classLevel && student.classLevel.gradeLevel != null
          ? String(student.classLevel.gradeLevel)
          : "",
        // Same parent convention as Top Performers: linked Parent record first,
        // then the student's own fatherName as fallback.
        parentName: (student.parent && student.parent.name) || student.fatherName || "",
      },
      attendancePercent: attPercent,
      averagePercent: pctCount > 0 ? Math.round((pctSum / pctCount) * 100) / 100 : null,
      tests: pctCount,
      reasons,
    });
  }

  // Sort: by roll number if requested, otherwise LOWEST AVERAGE FIRST (weakest
  // marks leads), ties broken by most low subjects.
  if (sortBy === "rollAsc") {
    atRisk.sort((a, b) => String(a.student.rollNumber || "").localeCompare(String(b.student.rollNumber || ""), undefined, { numeric: true }));
  } else if (sortBy === "rollDesc") {
    atRisk.sort((a, b) => String(b.student.rollNumber || "").localeCompare(String(a.student.rollNumber || ""), undefined, { numeric: true }));
  } else {
    atRisk.sort((a, b) => {
      const aAvg = a.averagePercent !== null ? a.averagePercent : 100;
      const bAvg = b.averagePercent !== null ? b.averagePercent : 100;
      if (aAvg !== bAvg) return aAvg - bAvg;
      return b.reasons.length - a.reasons.length;
    });
  }

  // Cap: panel default is MAX_LIST_SIZE; options.maxList = null returns the
  // full ranked list so the caller can slice per-grade buckets itself.
  const maxList = options && options.maxList !== undefined ? options.maxList : MAX_LIST_SIZE;

  return {
    students: maxList === null ? atRisk : atRisk.slice(0, maxList),
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
  //    Exclude the same population as the admin panel: withdrawn AND inactive
  //    students (previously this path only excluded withdrawn, so the two
  //    panels disagreed on which students were in scope).
  const students = await Student.find({
    classLevel: { $in: classLevelIds },
    isWithdrawn: { $ne: true },
    status: { $ne: "inactive" },
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
      .filter((r) => r.student.toString() === sid && r.test && r.test.totalMarks && r.absent !== true && r.score > 0)
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
