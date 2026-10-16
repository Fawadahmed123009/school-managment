const express = require("express");
const router = express.Router();
const Student = require("../../models/Students/students.model");
const Teacher = require("../../models/Staff/teachers.model");
const Fees = require("../../models/Fees/fees.model");
const Attendance = require("../../models/Academic/attendance.model");
const TestResult = require("../../models/Academic/testResult.model");
const Test = require("../../models/Academic/test.model");
const Assignment = require("../../models/Academic/assignment.model");
const { getAtRiskStudentsAdmin, getAtRiskStudentsTeacher, THRESHOLDS } = require("../../services/alerts/atRiskAlerts.service");
const { getPendingMarkingAllTeachers, getTeacherTestMarkingSummary, isBeyondMarkingGrace } = require("../../services/academic/markingFollowUp.service");
const { admissionCutoffForTest, isAdmittedByTest } = require("../../utils/testRosterEligibility");
const { dateKeyStage, localDateKey } = require("../../utils/localDateKey");
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

  const stats = { students: 0, staff: 0, inactiveStudents: 0, collected: 0, outstanding: 0 };
  const charts = { attendanceTrend: [], feeCollection: [], feeBreakdown: [], teacherTests: [] };
  let atRisk = null;
  let alertThresholds = THRESHOLDS;

  try {
    if (req.user.role === "admin" || req.user.isManager) {
      const isAdmin = req.user.role === "admin";

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      const sixMonthsAgo = monthsAgo(6);

      // Active-enrolled triple, used everywhere in the project: not inactive,
      // not graduated, not withdrawn. "Enrolled students" must count only these.
      const ACTIVE_STUDENTS = {
        status: { $ne: "inactive" },
        isGraduated: { $ne: true },
        isWithdrawn: { $ne: true },
      };

      // Shared fee scoping — replaces the old full-collection Fees.find().lean()
      // JS-loop with the SAME aggregate technique the fee charts already use:
      // soft-deleted rows are dropped by the Fees pre-aggregate hook, and the
      // $lookup drops arrears owed by inactive students so they never inflate
      // "outstanding". Reused by the KPI totals and both charts below.
      const feeScope = [
        { $lookup: { from: "students", localField: "student", foreignField: "_id", as: "_stu" } },
        { $addFields: { _stuStatus: { $arrayElemAt: ["$_stu.status", 0] } } },
        { $match: { $or: [{ status: "paid" }, { _stuStatus: { $ne: "inactive" } }] } },
      ];

      // School-wide test average + top performers share the scoring convention
      // already used by the student branch and the at-risk service: a result
      // contributes score/totalMarks as a percent, and absences (stored as a
      // placeholder score 0) are excluded so they never drag the average down.
      // Results are also limited to active-enrolled students.
      const scoredResultScope = [
        { $match: { absent: { $ne: true }, score: { $gt: 0 } } },
        { $lookup: { from: "tests", localField: "test", foreignField: "_id", as: "_test" } },
        { $addFields: { _totalMarks: { $arrayElemAt: ["$_test.totalMarks", 0] } } },
        { $match: { _totalMarks: { $gt: 0 } } },
        { $lookup: { from: "students", localField: "student", foreignField: "_id", as: "_stu" } },
        {
          $addFields: {
            _stuStatus: { $arrayElemAt: ["$_stu.status", 0] },
            _stuGrad: { $arrayElemAt: ["$_stu.isGraduated", 0] },
            _stuWith: { $arrayElemAt: ["$_stu.isWithdrawn", 0] },
            _pct: { $multiply: [{ $divide: ["$score", "$_totalMarks"] }, 100] },
          },
        },
        { $match: { _stuStatus: { $ne: "inactive" }, _stuGrad: { $ne: true }, _stuWith: { $ne: true } } },
      ];

      // Every fetch below is independent — none feeds another — so the whole
      // admin/manager data load runs concurrently in ONE Promise.all (was ~6
      // sequential awaits). The marking follow-up that used to be a separate
      // sequential block after the role chain is folded in here too. Fee
      // aggregates are admin-only (null for manager); everything else is shared.
      const [
        studentCount,
        staffCount,
        feeTotalsRows,
        attAgg,
        feeAgg,
        feeTypeAgg,
        atRiskResult,
        pendingMarking,
        teacherTests,
        inactiveCount,
        topPerformerRows,
        attLifetimeAgg,
      ] = await Promise.all([
        Student.countDocuments(ACTIVE_STUDENTS),
        Teacher.countDocuments(),
        isAdmin
          ? Fees.aggregate([
              ...feeScope,
              {
                $group: {
                  _id: null,
                  collected: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } },
                  outstanding: { $sum: { $cond: [{ $ne: ["$status", "paid"] }, "$amount", 0] } },
                },
              },
            ])
          : null,
        Attendance.aggregate([
          { $match: { date: { $gte: thirtyDaysAgo } } },
          {
            $group: {
              _id: dateKeyStage(),
              present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
              absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
              late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        // Fee collection by month — grouped with dateKeyStage() so buckets use
        // the school's LOCAL calendar (was plain UTC $dateToString, the same
        // off-by-one-day bug already fixed for attendance).
        isAdmin
          ? Fees.aggregate([
              { $match: { createdAt: { $gte: sixMonthsAgo } } },
              ...feeScope,
              {
                $group: {
                  _id: dateKeyStage("%Y-%m", "$createdAt"),
                  collected: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } },
                  outstanding: { $sum: { $cond: [{ $ne: ["$status", "paid"] }, "$amount", 0] } },
                },
              },
              { $sort: { _id: 1 } },
            ])
          : null,
        isAdmin
          ? Fees.aggregate([
              ...feeScope,
              {
                $group: {
                  _id: "$feeType",
                  total: { $sum: "$amount" },
                  paid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amount", 0] } },
                },
              },
              { $sort: { total: -1 } },
            ])
          : null,
        // FULL ranked list (no 10-row cap) — bucketed per grade tab below and
        // rendered as pre-built client-side lists, exactly like Top Performers,
        // so grade toggling never hits the server.
        getAtRiskStudentsAdmin(undefined, "", undefined, { maxList: null }),
        getPendingMarkingAllTeachers(),
        getTeacherTestMarkingSummary(),
        // Inactive pupils (status === "inactive") — mirrors the students-list
        // STATUS_CLAUSES.inactive filter so the KPI card matches that view.
        Student.countDocuments({ status: "inactive" }),
        // Top performers per grade, ranked by average %, with class grade and
        // parent name attached (via $lookup into classlevels / parents). No
        // $limit here — the whole ranked list is bucketed by grade below and
        // trimmed to the top 10 for each of grades 9–12.
        TestResult.aggregate([
          ...scoredResultScope,
          {
            $addFields: {
              _stuName: { $arrayElemAt: ["$_stu.name", 0] },
              _roll: { $arrayElemAt: ["$_stu.rollNumber", 0] },
              _classLevel: { $arrayElemAt: ["$_stu.classLevel", 0] },
              _parentRef: { $arrayElemAt: ["$_stu.parent", 0] },
              _fatherName: { $arrayElemAt: ["$_stu.fatherName", 0] },
            },
          },
          { $lookup: { from: "classlevels", localField: "_classLevel", foreignField: "_id", as: "_cl" } },
          { $addFields: { _grade: { $arrayElemAt: ["$_cl.gradeLevel", 0] } } },
          { $lookup: { from: "parents", localField: "_parentRef", foreignField: "_id", as: "_par" } },
          {
            $addFields: {
              // Prefer the linked Parent/Family record's name; fall back to the
              // student's own fatherName when no parent account is linked.
              _parentName: {
                $cond: [
                  { $gt: [{ $size: "$_par" }, 0] },
                  { $arrayElemAt: ["$_par.name", 0] },
                  "$_fatherName",
                ],
              },
            },
          },
          {
            $group: {
              _id: "$student",
              name: { $first: "$_stuName" },
              rollNumber: { $first: "$_roll" },
              gradeLevel: { $first: "$_grade" },
              parentName: { $first: "$_parentName" },
              tests: { $sum: 1 },
              avg: { $avg: "$_pct" },
            },
          },
          { $sort: { avg: -1, name: 1 } },
        ]),
        // Lifetime attendance % per student for the Top Performers "Att %" column
        // — the same (present + late) / total convention as the at-risk service,
        // over ALL attendance records (not the 30-day trend window).
        Attendance.aggregate([
          {
            $group: {
              _id: "$student",
              present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
              absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
              late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
            },
          },
        ]),
      ]);

      stats.students = studentCount;
      stats.staff = staffCount;
      stats.inactiveStudents = inactiveCount || 0;

      if (isAdmin && feeTotalsRows && feeTotalsRows.length > 0) {
        stats.collected = Math.round(feeTotalsRows[0].collected);
        stats.outstanding = Math.round(feeTotalsRows[0].outstanding);
      }

      // Attendance trend line keeps its shape; the donut reuses the SAME
      // aggregation's per-day present/absent/late — summed here, no second query.
      charts.attendanceTrend = attAgg.map((d) => ({
        date: d._id,
        rate: d.present + d.absent + d.late > 0
          ? Math.round(((d.present + d.late) / (d.present + d.absent + d.late)) * 100)
          : 0,
        total: d.present + d.absent + d.late,
      }));
      charts.attendanceBreakdown = attAgg.reduce(
        (t, d) => ({
          present: t.present + d.present,
          absent: t.absent + d.absent,
          late: t.late + d.late,
        }),
        { present: 0, absent: 0, late: 0 }
      );

      if (isAdmin) {
        charts.feeCollection = (feeAgg || []).map((d) => ({
          month: d._id,
          collected: d.collected,
          outstanding: d.outstanding,
        }));
        charts.feeBreakdown = (feeTypeAgg || []).map((d) => ({
          type: d._id || "Other",
          total: d.total,
          paid: d.paid,
        }));
      }

      // At-Risk lists bucketed per grade tab ("" = All grades). The incoming
      // list is already sorted lowest-average-first, so the first 10 seen for
      // a grade ARE that grade's 10 weakest — identical to a per-grade query.
      const AR_GRADE_TABS = ["9", "10", "11", "12"];
      const arLists = { "": [] };
      AR_GRADE_TABS.forEach((g) => { arLists[g] = []; });
      ((atRiskResult && atRiskResult.students) || []).forEach((r) => {
        if (arLists[""].length < 10) arLists[""].push(r);
        const bucket = arLists[r.student && r.student.gradeLevel ? String(r.student.gradeLevel) : ""];
        if (bucket && bucket.length < 10) bucket.push(r);
      });
      atRisk = {
        lists: arLists,
        gradeTabs: AR_GRADE_TABS,
        total: (atRiskResult && atRiskResult.total) || 0,
      };

      // Marking follow-up across all teachers (was a second sequential block),
      // minus the 3-day grace window — only tests held MORE than 3 days ago
      // are surfaced as awaiting marking on this panel.
      stats.marking = pendingMarking.filter((t) => isBeyondMarkingGrace(t.date));
      charts.teacherTests = teacherTests;

      // Top performers bucketed per grade (admin + manager). Rows arrive sorted
      // by average % desc, so the first 10 seen for a grade ARE its top 10.
      const GRADE_TABS = ["9", "10", "11", "12"];
      const attPctById = {};
      attLifetimeAgg.forEach((a) => {
        const total = a.present + a.absent + a.late;
        if (total > 0) attPctById[String(a._id)] = Math.round(((a.present + a.late) / total) * 10000) / 100;
      });
      const byGrade = {};
      GRADE_TABS.forEach((g) => { byGrade[g] = []; });
      (topPerformerRows || []).forEach((r) => {
        const bucket = byGrade[r.gradeLevel];
        if (!bucket || bucket.length >= 10) return;
        bucket.push({
          _id: r._id,
          name: r.name,
          rollNumber: r.rollNumber,
          parentName: r.parentName || "",
          tests: r.tests,
          average: Math.round(r.avg * 100) / 100,
          attendancePercent: attPctById[String(r._id)] !== undefined ? attPctById[String(r._id)] : null,
        });
      });
      stats.topPerformers = { gradeTabs: GRADE_TABS, byGrade };

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
        const key = localDateKey(r.date);
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
              _id: dateKeyStage(),
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
        // Only ENROLLED pupils count (active / not graduated / not withdrawn) —
        // the same active-student convention as the mark-entry roster, so a
        // child the school has let go never shows as outstanding marking.
        // `dateAdmitted` is fetched so a test's expected pool can drop pupils
        // who joined the class after it was held (see markStatus below).
        const teacherStudents = await Student.find({
          classLevel: { $in: [...assignedClassIds] },
          status: { $ne: "inactive" },
          isGraduated: { $ne: true },
          isWithdrawn: { $ne: true },
        }).select("_id classLevel dateAdmitted").lean();
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
        // The expected pool is the class's pupils who were ALREADY admitted on
        // the test's day: a student enrolled after it never sat that test, so
        // they must not be counted as outstanding marking — otherwise an old
        // test is pinned to "not fully marked" the moment a new child joins.
        // This mirrors the mark-entry roster at /tests/mark/:testId exactly.
        const markStatus = (test) => {
          const skey = String(test.subject && test.subject._id ? test.subject._id : test.subject);
          const subj = subjectAssignments[skey];
          const inScope = new Set(
            (test.classLevels || []).map((c) => String(c._id || c)).filter((id) => subj && subj.classLevelIds.has(id))
          );
          const admissionCutoff = admissionCutoffForTest(test.date);
          const expectedIds = teacherStudents
            .filter((s) => inScope.has(String(s.classLevel)) && isAdmittedByTest(s.dateAdmitted, admissionCutoff))
            .map((s) => s._id.toString());
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

    // Admin/manager marking follow-up (pendingMarking + teacherTests) and the
    // school-wide test widgets are fetched in the parallel batch above.
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
