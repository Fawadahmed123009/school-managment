const express = require("express");
const attendanceRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isAttendanceManager = require("../../../middlewares/isAttendanceManager");
const isTeacher = require("../../../middlewares/isTeacher");

const {
  markClassAttendanceController,
  getClassRosterForDateController,
  getClassAttendanceController,
  getMonthlyRollupController,
  getDailyRollupController,
  getStudentAttendanceHistoryController,
  getTeacherAttendanceController,
} = require("../../../controllers/academic/attendance.controller");

attendanceRouter.route("/attendance").post(isLoggedIn, isAttendanceManager, markClassAttendanceController);
attendanceRouter.route("/attendance/roster/:classLevelId").get(isLoggedIn, isAttendanceManager, getClassRosterForDateController);
attendanceRouter.route("/attendance/class/:classLevelId").get(isLoggedIn, isAttendanceManager, getClassAttendanceController);
attendanceRouter.route("/attendance/rollup").get(isLoggedIn, isAdminOrManager, getMonthlyRollupController);
attendanceRouter.route("/attendance/daily-rollup").get(isLoggedIn, isAdminOrManager, getDailyRollupController);
attendanceRouter.route("/attendance/student-history").get(isLoggedIn, isAdminOrManager, getStudentAttendanceHistoryController);
// Teacher-scoped attendance viewing (read-only, assignment-gated)
attendanceRouter.route("/attendance/teacher-view").get(isLoggedIn, isTeacher, getTeacherAttendanceController);

module.exports = attendanceRouter;
