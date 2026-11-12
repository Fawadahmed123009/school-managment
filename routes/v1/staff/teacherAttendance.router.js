const express = require("express");
const teacherAttendanceRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isAdmin = require("../../../middlewares/isAdmin");

const {
  markTeacherAttendanceController,
  getTeacherAttendanceDayController,
  getTeacherAttendanceTeachersController,
  getTeacherAttendanceHistoryController,
  getTeacherAttendanceSettingsController,
  updateTeacherAttendanceSettingsController,
} = require("../../../controllers/staff/teacherAttendance.controller");

// Teacher (staff) attendance — Phase 1. Manager/admin mark and view; only
// admin configures the late-arrival rule. No salary/pay surface here.
teacherAttendanceRouter.route("/teacher-attendance").post(isLoggedIn, isAdminOrManager, markTeacherAttendanceController);
teacherAttendanceRouter.route("/teacher-attendance/day").get(isLoggedIn, isAdminOrManager, getTeacherAttendanceDayController);
teacherAttendanceRouter.route("/teacher-attendance/teachers").get(isLoggedIn, isAdminOrManager, getTeacherAttendanceTeachersController);
teacherAttendanceRouter.route("/teacher-attendance/history").get(isLoggedIn, isAdminOrManager, getTeacherAttendanceHistoryController);
// Settings READ is manager-visible (they see the flags); WRITE is admin-only.
teacherAttendanceRouter.route("/teacher-attendance/settings")
  .get(isLoggedIn, isAdminOrManager, getTeacherAttendanceSettingsController)
  .put(isLoggedIn, isAdmin, updateTeacherAttendanceSettingsController);

module.exports = teacherAttendanceRouter;