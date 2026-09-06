const express = require("express");
const attendanceRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");
const isAttendanceManager = require("../../../middlewares/isAttendanceManager");

const {
  markClassAttendanceController,
  getClassRosterForDateController,
  getClassAttendanceController,
  getMonthlyRollupController,
  getDailyRollupController,
  getStudentAttendanceHistoryController,
} = require("../../../controllers/academic/attendance.controller");

attendanceRouter.route("/attendance").post(isLoggedIn, isAttendanceManager, markClassAttendanceController);
attendanceRouter.route("/attendance/roster/:classLevelId").get(isLoggedIn, isAttendanceManager, getClassRosterForDateController);
attendanceRouter.route("/attendance/class/:classLevelId").get(isLoggedIn, isAttendanceManager, getClassAttendanceController);
attendanceRouter.route("/attendance/rollup").get(isLoggedIn, isAdmin, getMonthlyRollupController);
attendanceRouter.route("/attendance/daily-rollup").get(isLoggedIn, isAdmin, getDailyRollupController);
attendanceRouter.route("/attendance/student-history").get(isLoggedIn, isAdmin, getStudentAttendanceHistoryController);

module.exports = attendanceRouter;
