const responseStatus = require("../../handlers/responseStatus.handler");
const Attendance = require("../../models/Academic/attendance.model");
const Student = require("../../models/Students/students.model");
const ClassLevel = require("../../models/Academic/class.model");
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
