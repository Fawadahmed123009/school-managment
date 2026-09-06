const responseStatus = require("../../handlers/responseStatus.handler");
const {
  markClassAttendanceService,
  getClassRosterForDateService,
  getClassAttendanceService,
  getMonthlyRollupService,
  getDailyRollupService,
  getStudentAttendanceHistoryService,
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

exports.getMonthlyRollupController = async (req, res) => {
  try {
    await getMonthlyRollupService(req.query.year, req.query.month, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getDailyRollupController = async (req, res) => {
  try {
    await getDailyRollupService(req.query.year, req.query.month, req.query.classLevel, res);
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
    };
    await getStudentAttendanceHistoryService(filters, req.query.studentId || null, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
