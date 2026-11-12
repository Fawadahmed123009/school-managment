const responseStatus = require("../../handlers/responseStatus.handler");
const {
  markTeacherAttendanceService,
  getTeacherAttendanceDayService,
  getTeacherAttendanceTeachersService,
  getTeacherAttendanceHistoryService,
  getTeacherAttendanceSettingsService,
  updateTeacherAttendanceSettingsService,
} = require("../../services/staff/teacherAttendance.service");

// Manager/admin marks one day's arrival/departure for a set of teachers.
// Body: { date: "YYYY-MM-DD", records: [{ teacher, arrivalTime, departureTime }] }
exports.markTeacherAttendanceController = async (req, res) => {
  try {
    const { date, records } = req.body;
    await markTeacherAttendanceService(date, records, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Roster + whatever is already marked for a day (pre-fills the marking UI).
exports.getTeacherAttendanceDayController = async (req, res) => {
  try {
    await getTeacherAttendanceDayService(req.query.date, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Active-teacher list for the history filter dropdown.
exports.getTeacherAttendanceTeachersController = async (req, res) => {
  try {
    await getTeacherAttendanceTeachersService(res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Date-wise history + summed working hours for a range (salary feeds Phase 2).
exports.getTeacherAttendanceHistoryController = async (req, res) => {
  try {
    const filters = {
      teacherId: req.query.teacherId || "",
      startDate: req.query.startDate || "",
      endDate: req.query.endDate || "",
      page: req.query.page,
      limit: req.query.limit,
    };
    await getTeacherAttendanceHistoryService(filters, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Late-rule read — managers need it to understand the flags they see.
exports.getTeacherAttendanceSettingsController = async (req, res) => {
  try {
    await getTeacherAttendanceSettingsService(res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Late-rule write — ADMIN ONLY (route-level isAdmin). Form bodies arrive as
// strings, so normalize the checkbox/number here before validation.
exports.updateTeacherAttendanceSettingsController = async (req, res) => {
  try {
    const raw = req.body.lateDetectionEnabled;
    const payload = {
      lateDetectionEnabled: raw === true || raw === "true" || raw === "on" || raw === "1",
      startTime: req.body.startTime,
      graceMinutes: req.body.graceMinutes,
    };
    await updateTeacherAttendanceSettingsService(payload, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};