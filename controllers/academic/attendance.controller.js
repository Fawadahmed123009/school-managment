const responseStatus = require("../../handlers/responseStatus.handler");
const {
  markClassAttendanceService,
  getClassRosterForDateService,
  getClassAttendanceService,
  getMonthlyRollupService,
  getDailyRollupService,
  getStudentAttendanceHistoryService,
  getTeacherAttendanceService,
} = require("../../services/academic/attendance.service");

exports.markClassAttendanceController = async (req, res) => {
  try {
    const { classLevel, date, records } = req.body;
    await markClassAttendanceService(classLevel, date, records, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getClassRosterForDateController = async (req, res) => {
  try {
    await getClassRosterForDateService(req.params.classLevelId, req.query.date, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getClassAttendanceController = async (req, res) => {
  try {
    await getClassAttendanceService(req.params.classLevelId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Now takes an explicit startDate/endDate range ("YYYY-MM-DD", both inclusive)
// instead of a year+month pair, so the "By class" tab can support day/week/
// month/custom-range filtering, same as the daily-rollup endpoint.
exports.getMonthlyRollupController = async (req, res) => {
  try {
    await getMonthlyRollupService(req.query.startDate, req.query.endDate, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Now takes an explicit startDate/endDate range ("YYYY-MM-DD", both inclusive)
// instead of a year+month pair. The view layer is responsible for turning
// whichever range type (day / week / month / custom) the user picked into
// this pair before calling the API.
exports.getDailyRollupController = async (req, res) => {
  try {
    await getDailyRollupService(req.query.startDate, req.query.endDate, req.query.classLevel, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getStudentAttendanceHistoryController = async (req, res) => {
  try {
    const filters = {
      classLevel: req.query.classLevel || "",
      rollNumber: req.query.rollNumber || "",
      name: req.query.name || "",
      sortBy: req.query.sortBy || "",
    };
    await getStudentAttendanceHistoryService(
      filters,
      req.query.studentId || null,
      req.query.startDate || null,
      req.query.endDate || null,
      res
    );
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Teacher-scoped attendance viewing (read-only, assignment-gated)
// Now accepts startDate/endDate + scope instead of year/month/tab.
exports.getTeacherAttendanceController = async (req, res) => {
  try {
    const filters = {
      classLevel: req.query.classLevel || "",
      startDate: req.query.startDate || "",
      endDate: req.query.endDate || "",
      scope: req.query.scope || "myClasses",
      sortBy: req.query.sortBy || "",
      studentId: req.query.studentId || "",
    };
    await getTeacherAttendanceService(req.userAuth.id, filters, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};