const responseStatus = require("../../handlers/responseStatus.handler");
const Attendance = require("../../models/Academic/attendance.model");
const Student = require("../../models/Students/students.model");
const ClassLevel = require("../../models/Academic/class.model");
const Assignment = require("../../models/Academic/assignment.model");
const mongoose = require("mongoose");
const { dateKeyStage, localDateKey } = require("../../utils/localDateKey");

// Students we count as "enrolled" for attendance. Mirrors the enrolled
// head-count convention used across the dashboards/reports: a student whose
// status is "inactive" is no longer expected in any roster and must never be
// marked, listed, or counted.
const ACTIVE_STUDENT_FILTER = { status: { $ne: "inactive" } };

// Bulk mark a whole class's attendance for one day in a single call
exports.markClassAttendanceService = async (classLevel, date, records, teacherId, res) => {
  if (!Array.isArray(records) || records.length === 0) {
    return responseStatus(res, 400, "failed", "No attendance records provided");
  }

  const day = new Date(date);
  day.setHours(0, 0, 0, 0);

  // Fail-closed guard: only active students of THIS class may be marked. A
  // direct API POST that names an inactive (or foreign) student is rejected in
  // full and nothing is written — hiding the row in the roster isn't enough.
  const submittedIds = records.map((r) => String(r.student));
  const activeStudents = await Student
    .find({ classLevel, ...ACTIVE_STUDENT_FILTER })
    .select("_id")
    .lean();
  const activeSet = new Set(activeStudents.map((s) => s._id.toString()));
  const disallowed = submittedIds.filter((id) => !activeSet.has(id));
  if (disallowed.length > 0) {
    return responseStatus(
      res, 403, "failed",
      "Cannot mark attendance for students who are not active in this class"
    );
  }

  const results = [];
  for (const r of records) {
    const updated = await Attendance.findOneAndUpdate(
      { student: r.student, date: day },
      { student: r.student, classLevel, date: day, status: r.status, markedBy: teacherId },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    results.push(updated);
  }

  return responseStatus(res, 201, "success", results);
};

// Roster for a class + whatever attendance already exists for a given day (used to pre-fill the marking UI)
exports.getClassRosterForDateService = async (classLevel, date, res) => {
  const students = await Student.find({ classLevel, ...ACTIVE_STUDENT_FILTER })
    .select("name studentId rollNumber parent")
    .populate("parent", "name");

  const day = new Date(date);
  day.setHours(0, 0, 0, 0);

  const existing = await Attendance.find({ classLevel, date: day });
  const existingMap = {};
  existing.forEach((e) => { existingMap[e.student.toString()] = e.status; });

  const roster = students.map((s) => ({
    student: s._id,
    name: s.name,
    studentId: s.studentId,
    rollNumber: s.rollNumber || "",
    parentName: s.parent ? s.parent.name : "",
    status: existingMap[s._id.toString()] || null,
  }));

  return responseStatus(res, 200, "success", roster);
};

// One class's attendance history (for the "browse per-class" view)
exports.getClassAttendanceService = async (classLevel, res) => {
  const records = await Attendance.find({ classLevel })
    .populate("student", "name studentId")
    .sort({ date: -1 });
  return responseStatus(res, 200, "success", records);
};

// Attendance rollup across all classes for an arbitrary date range (admin view).
// startDate/endDate are "YYYY-MM-DD" strings, both inclusive — the controller
// turns whichever range type (day / week / month / custom) the user picked
// on the "By class" tab into this pair before calling here.
exports.getMonthlyRollupService = async (startDate, endDate, res) => {
  const [sy, sm, sd] = String(startDate).split("-").map(Number);
  const [ey, em, ed] = String(endDate).split("-").map(Number);

  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  end.setDate(end.getDate() + 1); // push to next day so endDate itself is included

  const records = await Attendance.find({ date: { $gte: start, $lt: end } })
    .populate("classLevel", "name")
    .populate("student", "name");

  const byClass = {};
  for (const r of records) {
    const key = r.classLevel ? r.classLevel.name : "Unknown";
    if (!byClass[key]) byClass[key] = { present: 0, absent: 0, late: 0 };
    byClass[key][r.status]++;
  }

  return responseStatus(res, 200, "success", byClass);
};

// Day-by-day attendance rollup for an arbitrary date range (admin view).
// startDate/endDate are "YYYY-MM-DD" strings, both inclusive. This one
// function now powers the day / week / month / custom-range views on the
// rollup page — the controller is responsible for turning whichever range
// type the user picked into a concrete startDate/endDate pair before
// calling this. The aggregation itself is unchanged from the old
// year+month version; it just groups whatever's inside the range by day.
exports.getDailyRollupService = async (startDate, endDate, classLevel, res) => {
  const [sy, sm, sd] = String(startDate).split("-").map(Number);
  const [ey, em, ed] = String(endDate).split("-").map(Number);

  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  end.setDate(end.getDate() + 1); // push to the next day so endDate itself is included

  const matchStage = { date: { $gte: start, $lt: end } };
  if (classLevel && mongoose.Types.ObjectId.isValid(classLevel)) {
    matchStage.classLevel = new mongoose.Types.ObjectId(classLevel);
  }

  const agg = await Attendance.aggregate([
    { $match: matchStage },
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

  const days = agg.map((d) => ({
    date: d._id,
    present: d.present,
    absent: d.absent,
    late: d.late,
    total: d.present + d.absent + d.late,
  }));

  return responseStatus(res, 200, "success", days);
};

// Teacher-scoped attendance viewing: only shows data for the teacher's assigned classes.
// Read-only — does NOT open up attendance marking to regular teachers.
//
// Now accepts an explicit startDate/endDate range ("YYYY-MM-DD", both inclusive)
// instead of year+month, and a scope parameter to control which aggregations run:
//   scope: "myClasses"      → perClass summary across all assigned classes
//          "specificClass"  → perClass for one class + dailyTrend for that class
//          "specificStudent"→ perStudent list + studentHistory for one student
// Only the queries relevant to the requested scope are executed — no wasted aggregations.
exports.getTeacherAttendanceService = async (teacherId, filters, res) => {
  const { classLevel, startDate, endDate, scope, sortBy, studentId } = filters;

  // 1. Load the teacher's assigned classLevel IDs (enforced scoping — never skipped)
  const assignedClassLevels = await Assignment.distinct("classLevel", { teacher: teacherId });
  if (assignedClassLevels.length === 0) {
    return responseStatus(res, 200, "success", { classes: [], perClass: [], dailyTrend: [], perStudent: [], studentHistory: null });
  }

  // 2. If a specific classLevel filter is provided, validate it's in the assignment set
  let effectiveClassLevels = assignedClassLevels;
  if (classLevel && mongoose.Types.ObjectId.isValid(classLevel)) {
    const requested = new mongoose.Types.ObjectId(classLevel);
    const isAssigned = assignedClassLevels.some((id) => id.toString() === classLevel);
    if (!isAssigned) {
      return responseStatus(res, 403, "failed", "You are not assigned to this class");
    }
    effectiveClassLevels = [requested];
  }

  // 3. Load class documents for the dropdown (always needed for the scope selector)
  const classes = await ClassLevel.find({ _id: { $in: effectiveClassLevels } })
    .select("_id name gradeLevel group section")
    .sort("name");

  // 4. Build date range
  const [sy, sm, sd] = String(startDate).split("-").map(Number);
  const [ey, em, ed] = String(endDate).split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  end.setDate(end.getDate() + 1); // push past endDate so it's inclusive

  // 5. Run ONLY the aggregation(s) needed for the requested scope
  const result = { classes, perClass: [], dailyTrend: [], perStudent: [], studentHistory: null };

  if (scope === "specificStudent") {
    // ── Specific student: per-student list + one student's day-by-day history ──
    const studentClassFilter = {
      ...(classLevel && mongoose.Types.ObjectId.isValid(classLevel)
        ? { classLevel: new mongoose.Types.ObjectId(classLevel) }
        : { classLevel: { $in: effectiveClassLevels } }),
      ...ACTIVE_STUDENT_FILTER,
    };

    const students = await Student.find(studentClassFilter)
      .select("name studentId rollNumber classLevel")
      .populate("classLevel", "name")
      .sort("name")
      .lean();

    if (students.length > 0) {
      const studentIds = students.map((s) => s._id);
      const studentAgg = await Attendance.aggregate([
        {
          $match: {
            student: { $in: studentIds },
            date: { $gte: start, $lt: end },
          },
        },
        {
          $group: {
            _id: "$student",
            present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
            late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
          },
        },
      ]);

      const attMap = {};
      studentAgg.forEach((r) => { attMap[r._id.toString()] = r; });

      let perStudent = students.map((s) => {
        const a = attMap[s._id.toString()] || { present: 0, absent: 0, late: 0 };
        const total = a.present + a.absent + a.late;
        return {
          student: s._id,
          name: s.name,
          studentId: s.studentId,
          rollNumber: s.rollNumber,
          className: s.classLevel ? s.classLevel.name : "—",
          present: a.present,
          absent: a.absent,
          late: a.late,
          total,
          rate: total > 0 ? Math.round(((a.present + a.late) / total) * 10000) / 100 : null,
        };
      });

      if (sortBy === "rollAsc") {
        perStudent.sort((a, b) => String(a.rollNumber || "").localeCompare(String(b.rollNumber || ""), undefined, { numeric: true }));
      } else if (sortBy === "rollDesc") {
        perStudent.sort((a, b) => String(b.rollNumber || "").localeCompare(String(a.rollNumber || ""), undefined, { numeric: true }));
      }

      result.perStudent = perStudent;
    }

    // Load the specific student's day-by-day history if one is selected
    if (studentId && mongoose.Types.ObjectId.isValid(studentId)) {
      // Verify the selected student belongs to the teacher's scope
      const studentDoc = await Student.findById(studentId)
        .select("classLevel")
        .lean();
      if (studentDoc) {
        const studentClassId = studentDoc.classLevel ? studentDoc.classLevel.toString() : null;
        const isInScope = effectiveClassLevels.some((id) => id.toString() === studentClassId);
        if (!isInScope) {
          return responseStatus(res, 403, "failed", "You are not assigned to this student's class");
        }

        const records = await Attendance.find({
          student: new mongoose.Types.ObjectId(studentId),
          date: { $gte: start, $lt: end },
        })
          .sort({ date: 1 })
          .lean();

        const counts = { present: 0, absent: 0, late: 0 };
        const history = records.map((r) => {
          counts[r.status]++;
          return { date: localDateKey(r.date), status: r.status };
        });

        result.studentHistory = {
          history,
          summary: { present: counts.present, absent: counts.absent, late: counts.late, total: records.length },
        };
      }
    }
  } else {
    // ── scope "myClasses" or "specificClass": perClass summary ──
    const perClassAgg = await Attendance.aggregate([
      {
        $match: {
          classLevel: { $in: effectiveClassLevels },
          date: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: "$classLevel",
          present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
          late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
        },
      },
    ]);

    const classMap = {};
    classes.forEach((c) => { classMap[c._id.toString()] = c.name; });
    result.perClass = perClassAgg.map((r) => ({
      classLevel: r._id,
      className: classMap[r._id.toString()] || "Unknown",
      present: r.present,
      absent: r.absent,
      late: r.late,
      total: r.present + r.absent + r.late,
    }));

    // ── scope "specificClass": also compute dailyTrend for that one class ──
    if (scope === "specificClass" && classLevel && mongoose.Types.ObjectId.isValid(classLevel)) {
      const trendAgg = await Attendance.aggregate([
        {
          $match: {
            classLevel: new mongoose.Types.ObjectId(classLevel),
            date: { $gte: start, $lt: end },
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

      result.dailyTrend = trendAgg.map((d) => ({
        date: d._id,
        present: d.present,
        absent: d.absent,
        late: d.late,
        total: d.present + d.absent + d.late,
      }));
    }
  }

  return responseStatus(res, 200, "success", result);
};

// Attendance dashboard (admin/manager) — one call returns everything the
// dashboard layout needs for a date range (+ optional class scope):
//   • enrolled head-count (excludes status:"inactive" students — same
//     convention as the fees module's outstanding calc)
//   • range summary totals + rate  —  rate = (present + late) / totalMarked
//   • day-by-day rollup (powers KPI row, weekly trend, overview donut)
//   • class-wise breakdown with an `incomplete` flag per class
// The per-class part is skipped when classLevel scope is set (nothing to
// compare) or when breakdown=0 is passed (e.g. the monthly-report re-fetch),
// so we never run aggregations the caller won't render.
// `classLevels` (optional array) is the teacher-facing scope: when the caller
// passes the teacher's assigned class ids every aggregation is restricted to
// that set — enrolled counts, day totals, the class×day breakdown and the
// class-wise rows all cover only those classes. An EMPTY array fails closed
// (zeroed payload, no aggregates run). Undefined = unscoped (admin/manager).
exports.getAttendanceDashboardService = async (startDate, endDate, classLevel, includeClassBreakdown, res, classLevels = undefined) => {
  if (!startDate || !endDate) {
    return responseStatus(res, 400, "failed", "startDate and endDate are required");
  }

  const [sy, sm, sd] = String(startDate).split("-").map(Number);
  const [ey, em, ed] = String(endDate).split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  end.setDate(end.getDate() + 1); // push past endDate so it's inclusive

  const teacherScoped = Array.isArray(classLevels);
  const scopeIds = teacherScoped
    ? classLevels.map((id) => new mongoose.Types.ObjectId(id))
    : [];

  // Teacher with zero assignments → nothing to show. Never fall through to
  // the unscoped pipeline, which would expose institute-wide data.
  if (teacherScoped && scopeIds.length === 0) {
    return responseStatus(res, 200, "success", {
      range: { startDate, endDate, classLevel: null },
      enrolled: 0,
      enrolledTotal: 0,
      summary: { present: 0, absent: 0, late: 0, marked: 0, rate: null },
      days: [],
      classes: [],
    });
  }

  const scopedClass = classLevel && mongoose.Types.ObjectId.isValid(classLevel)
    ? new mongoose.Types.ObjectId(classLevel)
    : null;

  const matchStage = { date: { $gte: start, $lt: end } };
  if (scopedClass) matchStage.classLevel = scopedClass;
  else if (teacherScoped) matchStage.classLevel = scopeIds.length === 1 ? scopeIds[0] : { $in: scopeIds };

  const rateOf = (p, l, total) =>
    total > 0 ? Math.round(((p + l) / total) * 10000) / 100 : null;

  const [dayAgg, classDayAgg, enrolledByClassAgg, classDocs] = await Promise.all([
    // Day-by-day totals for the range (served by the {date} / {classLevel,date} indexes)
    Attendance.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: dateKeyStage(),
          present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
          absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
          late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
          marked: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // Class × day counts for the per-class table + incomplete flagging.
    // Single grouping; reduced in Node — the row count stays small (classes × marked days).
    includeClassBreakdown && !scopedClass
      ? Attendance.aggregate([
          { $match: { ...matchStage } },
          {
            $group: {
              _id: { classLevel: "$classLevel", date: dateKeyStage() },
              present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
              absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
              late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
              marked: { $sum: 1 },
            },
          },
        ])
      : Promise.resolve([]),
    // Enrolled head-count per class (active students only) — teacher-scoped
    // so the head-count and enrolledTotal reflect only the assigned classes.
    Student.aggregate([
      { $match: teacherScoped
        ? { ...ACTIVE_STUDENT_FILTER, classLevel: { $in: scopeIds } }
        : { ...ACTIVE_STUDENT_FILTER } },
      { $group: { _id: "$classLevel", n: { $sum: 1 } } },
    ]),
    ClassLevel.find(teacherScoped ? { _id: { $in: scopeIds } } : {}, "_id name").sort("name").lean(),
  ]);

  const days = dayAgg.map((d) => ({
    date: d._id,
    present: d.present,
    absent: d.absent,
    late: d.late,
    marked: d.marked,
    rate: rateOf(d.present, d.late, d.marked),
  }));

  const summary = dayAgg.reduce(
    (acc, d) => ({ present: acc.present + d.present, absent: acc.absent + d.absent, late: acc.late + d.late, marked: acc.marked + d.marked }),
    { present: 0, absent: 0, late: 0, marked: 0 }
  );
  summary.rate = rateOf(summary.present, summary.late, summary.marked);

  const enrolledByClass = {};
  let enrolledTotal = 0;
  for (const e of enrolledByClassAgg) {
    if (!e._id) continue; // student without a class — can't be expected in any roster
    enrolledByClass[e._id.toString()] = e.n;
    enrolledTotal += e.n;
  }

  // Scope-aware "enrolled" for the banner: one class's head-count when filtered,
  // whole institute otherwise.
  const scopeEnrolled = scopedClass ? enrolledByClass[scopedClass.toString()] || 0 : enrolledTotal;

  let classes = [];
  if (includeClassBreakdown && !scopedClass) {
    // Merge attendance per class + per-class covered-days from the classDayAgg
    const byClass = {};
    for (const r of classDayAgg) {
      if (!r._id.classLevel) continue;
      const key = r._id.classLevel.toString();
      if (!byClass[key]) byClass[key] = { present: 0, absent: 0, late: 0, marked: 0, coveredDays: 0 };
      byClass[key].present += r.present;
      byClass[key].absent += r.absent;
      byClass[key].late += r.late;
      byClass[key].marked += r.marked;
      byClass[key].coveredDays += 1;
    }

    // "Marked days" = days with any attendance institute-wide in this range.
    // A class is flagged incomplete when its records fall short of
    // enrolled × markedDays (i.e. someone, somewhere, is unmarked for a day
    // the institute was marked at all — matches how the banner reads for a day).
    const markedDays = days.length;
    const seen = new Set();
    classes = classDocs
      .map((c) => {
        const key = c._id.toString();
        seen.add(key);
        const a = byClass[key] || { present: 0, absent: 0, late: 0, marked: 0, coveredDays: 0 };
        const enrolled = enrolledByClass[key] || 0;
        const expected = enrolled * markedDays;
        return {
          classLevel: key,
          name: c.name,
          enrolled,
          present: a.present,
          absent: a.absent,
          late: a.late,
          marked: a.marked,
          coveredDays: a.coveredDays,
          rate: rateOf(a.present, a.late, a.marked),
          incomplete: enrolled > 0 && a.marked < expected,
        };
      })
      // include attendance-bearing classes whose id is no longer in ClassLevel
      // (orphaned records — shouldn't happen, but never hide data)
      .concat(
        Object.keys(byClass)
          .filter((k) => !seen.has(k))
          .map((k) => ({
            classLevel: k, name: "Unknown", enrolled: enrolledByClass[k] || 0,
            ...byClass[k], rate: rateOf(byClass[k].present, byClass[k].late, byClass[k].marked),
            incomplete: false,
          }))
      )
      .filter((c) => c.enrolled > 0 || c.marked > 0);
  }

  return responseStatus(res, 200, "success", {
    range: { startDate, endDate, classLevel: scopedClass ? scopedClass.toString() : null },
    enrolled: scopeEnrolled,
    enrolledTotal,
    summary,
    days,
    classes,
  });
};

// Search students for attendance history + optionally load one student's history
// within an explicit date range (startDate/endDate are "YYYY-MM-DD", both inclusive).
// When startDate/endDate are omitted the full history is returned (defensive fallback).
exports.getStudentAttendanceHistoryService = async (filters, selectedStudentId, startDate, endDate, res) => {
  const { classLevel, rollNumber, name, sortBy } = filters;

  // Build student search filter — same pattern as students list / fees list.
  // Inactive students are excluded, consistent with the marking roster.
  const studentFilter = { ...ACTIVE_STUDENT_FILTER };
  if (classLevel && mongoose.Types.ObjectId.isValid(classLevel)) {
    studentFilter.classLevel = new mongoose.Types.ObjectId(classLevel);
  }
  if (rollNumber) {
    studentFilter.rollNumber = { $regex: String(rollNumber).trim(), $options: "i" };
  }
  if (name) studentFilter.name = { $regex: name, $options: "i" };

  let studentQuery = Student.find(studentFilter)
    .select("name rollNumber email")
    .populate({ path: "classLevel", select: "name gradeLevel section" });

  if (sortBy === "rollAsc") {
    studentQuery = studentQuery.sort({ rollNumber: 1 }).collation({ locale: "en", numericOrdering: true });
  } else if (sortBy === "rollDesc") {
    studentQuery = studentQuery.sort({ rollNumber: -1 }).collation({ locale: "en", numericOrdering: true });
  } else {
    studentQuery = studentQuery.sort("name");
  }

  const students = await studentQuery.lean();

  let history = null;
  let summary = null;

  if (selectedStudentId && mongoose.Types.ObjectId.isValid(selectedStudentId)) {
    // Build date-range filter if explicit range was provided
    const historyMatch = { student: new mongoose.Types.ObjectId(selectedStudentId) };
    if (startDate && endDate) {
      const [sy, sm, sd] = String(startDate).split("-").map(Number);
      const [ey, em, ed] = String(endDate).split("-").map(Number);
      const start = new Date(sy, sm - 1, sd);
      const end = new Date(ey, em - 1, ed);
      end.setDate(end.getDate() + 1); // push past endDate so it's inclusive
      historyMatch.date = { $gte: start, $lt: end };
    }

    const records = await Attendance.find(historyMatch)
      .sort({ date: 1 })
      .lean();

    const counts = { present: 0, absent: 0, late: 0 };
    history = records.map((r) => {
      counts[r.status]++;
      return {
        date: localDateKey(r.date),
        status: r.status,
      };
    });

    const total = records.length;
    summary = {
      present: counts.present,
      absent: counts.absent,
      late: counts.late,
      total,
    };
  }

  return responseStatus(res, 200, "success", { students, history, summary });
};