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
  const students = await Student.find({ classLevel }).select("name studentId");

  const day = new Date(date);
  day.setHours(0, 0, 0, 0);

  const existing = await Attendance.find({ classLevel, date: day });
  const existingMap = {};
  existing.forEach((e) => { existingMap[e.student.toString()] = e.status; });

  const roster = students.map((s) => ({
    student: s._id,
    name: s.name,
    studentId: s.studentId,
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

// Monthly rollup across all classes (admin view)
exports.getMonthlyRollupService = async (year, month, res) => {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

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

// Day-by-day attendance rollup for a month (admin view)
// Reuses the same $group aggregation pattern from the dashboard's attendance trend
exports.getDailyRollupService = async (year, month, classLevel, res) => {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);

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
exports.getTeacherAttendanceService = async (teacherId, filters, res) => {
  const { classLevel, year, month, tab } = filters;

  // 1. Load the teacher's assigned classLevel IDs
  const assignedClassLevels = await Assignment.distinct("classLevel", { teacher: teacherId });
  if (assignedClassLevels.length === 0) {
    return responseStatus(res, 200, "success", { classes: [], perClass: [], perStudent: [] });
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

  // 3. Load class documents for the dropdown
  const classes = await ClassLevel.find({ _id: { $in: effectiveClassLevels } })
    .select("_id name gradeLevel group section")
    .sort("name");

  // 4. Build date range
  const now = new Date();
  const y = year ? Number(year) : now.getFullYear();
  const m = month ? Number(month) : now.getMonth() + 1;
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1);

  // 5. Per-class summary aggregation (same $group pattern as getMonthlyRollupService)
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

  // Annotate with class name
  const classMap = {};
  classes.forEach((c) => { classMap[c._id.toString()] = c.name; });
  const perClass = perClassAgg.map((r) => ({
    classLevel: r._id,
    className: classMap[r._id.toString()] || "Unknown",
    present: r.present,
    absent: r.absent,
    late: r.late,
    total: r.present + r.absent + r.late,
  }));

  // 6. Per-student breakdown (for the "student" tab, scoped to selected class or all assigned)
  let perStudent = [];
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

    perStudent = students.map((s) => {
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
  }

  return responseStatus(res, 200, "success", {
    classes,
    perClass,
    perStudent,
    year: y,
    month: m,
  });
};

// Search students for attendance history + optionally load one student's full history
exports.getStudentAttendanceHistoryService = async (filters, selectedStudentId, res) => {
  const { classLevel, rollNumber, name } = filters;

  // Build student search filter — same pattern as students list / fees list
  const studentFilter = {};
  if (classLevel && mongoose.Types.ObjectId.isValid(classLevel)) {
    studentFilter.classLevel = new mongoose.Types.ObjectId(classLevel);
  }
  if (rollNumber) {
    const asNum = Number(rollNumber);
    if (!isNaN(asNum)) studentFilter.rollNumber = asNum;
    else studentFilter.rollNumber = { $regex: rollNumber, $options: "i" };
  }
  if (name) studentFilter.name = { $regex: name, $options: "i" };

  const students = await Student.find(studentFilter)
    .select("name rollNumber email")
    .populate({ path: "classLevel", select: "name gradeLevel section" })
    .sort("name")
    .lean();

  let history = null;
  let summary = null;

  if (selectedStudentId && mongoose.Types.ObjectId.isValid(selectedStudentId)) {
    const records = await Attendance.find({ student: new mongoose.Types.ObjectId(selectedStudentId) })
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
