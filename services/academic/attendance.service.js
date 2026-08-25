const responseStatus = require("../../handlers/responseStatus.handler");
const Attendance = require("../../models/Academic/attendance.model");
const Student = require("../../models/Students/students.model");

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
