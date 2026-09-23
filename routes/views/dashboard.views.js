const express = require("express");
const router = express.Router();
const Student = require("../../models/Students/students.model");
const Teacher = require("../../models/Staff/teachers.model");
const Fees = require("../../models/Fees/fees.model");
const Attendance = require("../../models/Academic/attendance.model");
const TestResult = require("../../models/Academic/testResult.model");
const Test = require("../../models/Academic/test.model");
const Assignment = require("../../models/Academic/assignment.model");
const ClassLevel = require("../../models/Academic/class.model");
const { getAtRiskStudentsAdmin, getAtRiskStudentsTeacher, THRESHOLDS } = require("../../services/alerts/atRiskAlerts.service");
const { getPendingMarkingAllTeachers } = require("../../services/academic/markingFollowUp.service");
const logger = require("../../config/logger");

// ── Helper: start-of-month date for MongoDB queries ──
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ── Helper: Monday–Sunday bounds of the current calendar week (server-local) ──
function currentWeekBounds(base = new Date()) {
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  const dow = start.getDay(); // 0=Sun … 6=Sat
  start.setDate(start.getDate() - ((dow + 6) % 7)); // step back to Monday
  const end = new Date(start);
  end.setDate(start.getDate() + 7); // exclusive upper bound
  return { start, end };
}

router.get("/dashboard", async (req, res) => {
  // Redirect parents to their own portal
  if (req.user && req.user.role === "parent") {
    return res.redirect("/parent-portal");
  }

  const stats = { students: 0, staff: 0, collected: 0, outstanding: 0 };
  const charts = { attendanceTrend: [], feeCollection: [], feeBreakdown: [] };
  let atRisk = null;
  let alertThresholds = THRESHOLDS;

  try {
    if (req.user.role === "admin" || req.user.isManager) {
      const isAdmin = req.user.role === "admin";
      const fetches = [
        Student.countDocuments(),
        Teacher.countDocuments(),
      ];
      // Only fetch fee data for full admin (not manager)
      if (isAdmin) fetches.push(Fees.find().lean());
      // Resolve inactive student IDs to exclude their unpaid fees from stats
      const inactiveStudents = await Student.find({ status: "inactive" }).select("_id").lean();
      const inactiveSet = new Set(inactiveStudents.map((s) => s._id.toString()));
      const results = await Promise.all(fetches);
      stats.students = results[0];
      stats.staff = results[1];
      if (isAdmin && results[2]) {
        for (const f of results[2]) {
          if (f.status === "paid") stats.collected += f.amount;
          else if (!inactiveSet.has(f.student.toString())) stats.outstanding += f.amount;
        }
      }

      // ── Chart data: Attendance trend (last 30 days) ──
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);

      const attAgg = await Attendance.aggregate([
        { $match: { date: { $gte: thirtyDaysAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
            present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
            late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      charts.attendanceTrend = attAgg.map((d) => ({
        date: d._id,
        rate: d.present + d.absent + d.late > 0
          ? Math.round(((d.present + d.late) / (d.present + d.absent + d.late)) * 100)
          : 0,
        total: d.present + d.absent + d.late,
      }));

      // Fee charts only for full admin (not manager)
      if (req.user.role === "admin") {
        // ── Chart data: Fee collection (last 6 months) ──
        const sixMonthsAgo = monthsAgo(6);
        const feeAgg = await Fees.aggregate([
          { $match: { createdAt: { $gte: sixMonthsAgo } } },
          // Join student to check status — exclude unpaid fees for inactive students
          { $lookup: { from: "students", localField: "student", foreignField: "_id", as: "_stu" } },
          { $addFields: { _stuStatus: { $arrayElemAt: ["$_stu.status", 0] } } },
          { $match: { $or: [{ status: "paid" }, { _stuStatus: { $ne: "inactive" } }] } },
          { $project: { _stu: 0, _stuStatus: 0 } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
              collected: {
                $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] },
              },
              outstanding: {
                $sum: { $cond: [{ $ne: ["$status", "paid"] }, "$amount", 0] },
              },
            },
          },
          { $sort: { _id: 1 } },
        ]);

        charts.feeCollection = feeAgg.map((d) => ({
          month: d._id,
          collected: d.collected,
          outstanding: d.outstanding,
        }));

        // ── Chart data: Fee breakdown by type ──
        const feeTypeAgg = await Fees.aggregate([
          // Exclude unpaid fees for inactive students
          { $lookup: { from: "students", localField: "student", foreignField: "_id", as: "_stu" } },
          { $addFields: { _stuStatus: { $arrayElemAt: ["$_stu.status", 0] } } },
          { $match: { $or: [{ status: "paid" }, { _stuStatus: { $ne: "inactive" } }] } },
          { $project: { _stu: 0, _stuStatus: 0 } },
          {
            $group: {
              _id: "$feeType",
              total: { $sum: "$amount" },
              paid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } },
            },
          },
          { $sort: { total: -1 } },
        ]);

        charts.feeBreakdown = feeTypeAgg.map((d) => ({
          type: d._id || "Other",
          total: d.total,
          paid: d.paid,
        }));
      }

      // ── At-Risk Students panel ──
      const classFilter = req.query.classLevel || "";
      const sortBy = req.query.sortBy || "";
      const [atRiskResult, classes] = await Promise.all([
        getAtRiskStudentsAdmin(classFilter || undefined, sortBy),
        ClassLevel.find().sort({ gradeLevel: 1, name: 1 }).lean(),
      ]);
      atRisk = {
        ...atRiskResult,
        classFilter,
        sortBy,
        classes,
      };

    } else if (req.user.role === "student") {
      const studentId = req.user._id;
      const [attendanceRecords, testResults, feeRecords, student] = await Promise.all([
        Attendance.find({ student: studentId }),
        TestResult.find({ student: studentId }).populate({
          path: "test",
          populate: [{ path: "subject", select: "name" }, { path: "session", select: "name" }],
        }),
        Fees.find({ student: studentId }),
        Student.findById(studentId).select("name photoUrl").populate("classLevel", "name gradeLevel"),
      ]);

      // Attendance
      const attTotals = { present: 0, absent: 0, late: 0 };
      attendanceRecords.forEach((r) => { attTotals[r.status]++; });
      const totalMarked = attendanceRecords.length;
      stats.attendance = {
        totalMarked,
        ...attTotals,
        percent: totalMarked > 0 ? Math.round(((attTotals.present + attTotals.late) / totalMarked) * 10000) / 100 : null,
      };

      // ── Chart data: Student attendance trend (last 30 days) ──
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);

      const myAtt = attendanceRecords
        .filter((r) => r.date >= thirtyDaysAgo)
        .sort((a, b) => a.date - b.date);

      const attByDate = {};
      myAtt.forEach((r) => {
        const key = r.date.toISOString().slice(0, 10);
        attByDate[key] = r.status;
      });
      charts.attendanceTrend = Object.entries(attByDate).map(([date, status]) => ({
        date,
        status,
      }));

      // Marks
      const percents = testResults
        .filter((r) => r.test && r.test.totalMarks)
        .map((r) => Math.round((r.score / r.test.totalMarks) * 10000) / 100);
      stats.marks = {
        overallAverage: percents.length > 0 ? Math.round(percents.reduce((s, p) => s + p, 0) / percents.length * 100) / 100 : null,
        totalTests: testResults.length,
      };

      // ── Chart data: Student test scores ──
      charts.testScores = testResults
        .filter((r) => r.test && r.test.totalMarks)
        .map((r) => ({
          subject: r.test.subject ? r.test.subject.name : "Unknown",
          score: Math.round((r.score / r.test.totalMarks) * 100),
        }));

      // Fees
      const feeTotals = { total: 0, paid: 0, pending: 0 };
      feeRecords.forEach((f) => {
        feeTotals.total += f.amount;
        if (f.status === "paid") feeTotals.paid += f.amount;
        else feeTotals.pending += f.amount;
      });
      stats.fees = feeTotals;
      stats.student = student ? { name: student.name, classLevel: student.classLevel } : null;

      // ── Per-subject averages for student alert badges ──
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
      stats.marks.bySubject = Object.keys(subjectAgg)
        .map((subject) => ({
          subject,
          average: Math.round((subjectAgg[subject].total / subjectAgg[subject].count) * 100) / 100,
        }))
        .sort((a, b) => a.average - b.average);

    } else if (req.user.role === "teacher") {
      const teacherId = req.user._id;

      // ── Fetch teacher's class assignments ──
      const assignments = await Assignment.find({ teacher: teacherId })
        .populate("subject", "name")
        .populate("classLevel", "name gradeLevel group section");

      const classLevelIds = assignments.map((a) => a.classLevel && a.classLevel._id).filter(Boolean);

      // ── Count students enrolled in the teacher's assigned classes ──
      const enrolledStudents = classLevelIds.length > 0
        ? await Student.countDocuments({ classLevel: { $in: classLevelIds }, isWithdrawn: { $ne: true } })
        : 0;

      stats.teacher = {
        assignments: assignments.map((a) => ({
          subject: a.subject ? a.subject.name : "Unknown",
          classLevel: a.classLevel ? a.classLevel.name : "Unknown",
          gradeLevel: a.classLevel ? a.classLevel.gradeLevel : "",
          group: a.classLevel ? a.classLevel.group : null,
          section: a.classLevel ? a.classLevel.section : null,
        })),
        totalClasses: assignments.length,
        enrolledStudents,
      };

      // ── Chart data: Attendance trend for teacher's classes (last 30 days) ──
      if (classLevelIds.length > 0) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        thirtyDaysAgo.setHours(0, 0, 0, 0);

        const attAgg = await Attendance.aggregate([
          {
            $match: {
              classLevel: { $in: classLevelIds },
              date: { $gte: thirtyDaysAgo },
            },
          },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
              present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
              absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
              late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ]);

        charts.attendanceTrend = attAgg.map((d) => ({
          date: d._id,
          rate:
            d.present + d.absent + d.late > 0
              ? Math.round(((d.present + d.late) / (d.present + d.absent + d.late)) * 100)
              : 0,
          total: d.present + d.absent + d.late,
        }));
      }

      // ── At-Risk Students panel (teacher-scoped) ──
      atRisk = await getAtRiskStudentsTeacher(teacherId);

      // ── Marking follow-up: overdue unmarked tests + this-week subject chart ──
      // Build a subject → assigned-class-levels map from the teacher's roster.
      const subjectAssignments = {}; // subjectId(string) → { id, name, classLevelIds:Set }
      assignments.forEach((a) => {
        const sid = a.subject && a.subject._id;
        const cid = a.classLevel && a.classLevel._id;
        if (!sid || !cid) return;
        const key = sid.toString();
        if (!subjectAssignments[key]) {
          subjectAssignments[key] = { id: sid, name: a.subject.name || "Unknown", classLevelIds: new Set() };
        }
        subjectAssignments[key].classLevelIds.add(cid.toString());
      });
      const subjectIds = Object.keys(subjectAssignments);
      const assignedClassIds = new Set();
      Object.values(subjectAssignments).forEach((s) => s.classLevelIds.forEach((c) => assignedClassIds.add(c)));

      if (subjectIds.length > 0 && assignedClassIds.size > 0) {
        // Students in the teacher's classes, mapped to their class level.
        const teacherStudents = await Student.find({
          classLevel: { $in: [...assignedClassIds] },
          isWithdrawn: { $ne: true },
        }).select("_id classLevel").lean();
        const teacherStudentIds = teacherStudents.map((s) => s._id);

        const now = new Date();
        const { start: weekStart, end: weekEnd } = currentWeekBounds(now);

        // Selected subject (validated against the teacher's own subjects).
        let selectedSubjectId = req.query.subject;
        if (!subjectAssignments[selectedSubjectId]) selectedSubjectId = subjectIds[0];

        // Tests already past their date (candidate overdue) + this week's tests
        // for the selected subject, both scoped to the teacher's classes.
        const [overdueTests, weekTests] = await Promise.all([
          Test.find({
            subject: { $in: subjectIds },
            classLevels: { $in: [...assignedClassIds] },
            date: { $lt: now },
          }).populate("subject", "name").populate("classLevels", "name").sort({ date: 1 }).lean(),
          Test.find({
            subject: selectedSubjectId,
            classLevels: { $in: [...subjectAssignments[selectedSubjectId].classLevelIds] },
            date: { $gte: weekStart, $lt: weekEnd },
          }).populate("classLevels", "name").lean(),
        ]);

        // Fetch every relevant result once and group marked student ids per test.
        const relevantTestIds = [...new Set([...overdueTests, ...weekTests].map((t) => t._id))];
        const markedByTest = {};
        if (relevantTestIds.length > 0 && teacherStudentIds.length > 0) {
          const results = await TestResult.find({
            test: { $in: relevantTestIds },
            student: { $in: teacherStudentIds },
          }).select("test student").lean();
          results.forEach((r) => {
            const k = r.test.toString();
            (markedByTest[k] || (markedByTest[k] = new Set())).add(r.student.toString());
          });
        }

        // How many of the teacher's in-scope students are marked for a test.
        const markStatus = (test) => {
          const skey = String(test.subject && test.subject._id ? test.subject._id : test.subject);
          const subj = subjectAssignments[skey];
          const inScope = new Set(
            (test.classLevels || []).map((c) => String(c._id || c)).filter((id) => subj && subj.classLevelIds.has(id))
          );
          const expectedIds = teacherStudents.filter((s) => inScope.has(String(s.classLevel))).map((s) => s._id.toString());
          const markedSet = markedByTest[String(test._id)] || new Set();
          const marked = expectedIds.reduce((n, id) => n + (markedSet.has(id) ? 1 : 0), 0);
          return { expected: expectedIds.length, marked };
        };

        // ── Overdue, not-fully-marked tests ──
        const overdueUnmarked = [];
        overdueTests.forEach((t) => {
          const { expected, marked } = markStatus(t);
          if (expected > 0 && marked < expected) {
            overdueUnmarked.push({
              _id: t._id,
              name: t.name,
              subject: t.subject ? t.subject.name : "Unknown",
              classes: (t.classLevels || []).map((c) => c && c.name).filter(Boolean).join(", "),
              date: t.date,
              expected,
              marked,
            });
          }
        });

        // ── This-week marked vs unmarked per day, for the selected subject ──
        const days = [];
        const dayMap = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(weekStart);
          d.setDate(weekStart.getDate() + i);
          const bucket = {
            label: d.toLocaleDateString("en-US", { weekday: "short" }),
            date: new Date(d).toISOString().slice(0, 10),
            key: d.toDateString(),
            marked: 0,
            unmarked: 0,
          };
          days.push(bucket);
          dayMap[bucket.key] = bucket;
        }
        weekTests.forEach((t) => {
          const bucket = dayMap[new Date(t.date).toDateString()];
          if (!bucket) return;
          const { expected, marked } = markStatus(t);
          if (expected > 0 && marked >= expected) bucket.marked++;
          else bucket.unmarked++;
        });

        stats.teacher.overdueUnmarked = overdueUnmarked;
        stats.teacher.subjects = subjectIds.map((k) => ({ id: subjectAssignments[k].id.toString(), name: subjectAssignments[k].name }));
        stats.teacher.selectedSubject = selectedSubjectId;
        charts.weekTests = {
          subjectName: subjectAssignments[selectedSubjectId].name,
          days,
        };
      }
    }

    // ── Admin/Manager: marking follow-up across ALL teachers ──
    // Same scoping as each teacher's own panel above, aggregated per teacher.
    if (req.user.role === "admin" || req.user.isManager) {
      stats.marking = await getPendingMarkingAllTeachers();
    }
  } catch (err) {
    logger.warn("Dashboard stats error", { error: err.message, userId: req.user?._id });
    // graceful degradation — dashboard still renders with zeros
  }

  res.render("dashboard", {
    page: "dashboard",
    user: req.user,
    stats,
    charts,
    atRisk,
    alertThresholds,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
