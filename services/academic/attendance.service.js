const responseStatus = require("../../handlers/responseStatus.handler");
const Attendance = require("../../models/Academic/attendance.model");
const Student = require("../../models/Students/students.model");
const ClassLevel = require("../../models/Academic/class.model");
const Assignment = require("../../models/Academic/assignment.model");
const mongoose = require("mongoose");

// Bulk mark a whole class's attendance for one day in a single call
exports.markClassAttendanceService = async (classLevel, date, records, teacherId, res) => {
  if (!Array.isArray(records) || records.length === 0) {
    return responseStatus(res, 400, "failed", "No attendance records provided");
  }

  const day = new Date(date);
  day.setHours(0, 0, 0, 0);

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
  const students = await Student.find({ classLevel })
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
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
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
    const studentClassFilter = classLevel && mongoose.Types.ObjectId.isValid(classLevel)
      ? { classLevel: new mongoose.Types.ObjectId(classLevel) }
      : { classLevel: { $in: effectiveClassLevels } };

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
          return { date: r.date.toISOString().slice(0, 10), status: r.status };
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
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
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

// Search students for attendance history + optionally load one student's history
// within an explicit date range (startDate/endDate are "YYYY-MM-DD", both inclusive).
// When startDate/endDate are omitted the full history is returned (defensive fallback).
exports.getStudentAttendanceHistoryService = async (filters, selectedStudentId, startDate, endDate, res) => {
  const { classLevel, rollNumber, name, sortBy } = filters;

  // Build student search filter — same pattern as students list / fees list
  const studentFilter = {};
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
        date: r.date.toISOString().slice(0, 10),
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