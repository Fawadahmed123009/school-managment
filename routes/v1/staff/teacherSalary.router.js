const express = require("express");
const teacherSalaryRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");

const {
  getTeacherPayConfigsController,
  createTeacherPayConfigController,
  getTeacherSalarySettingsController,
  updateTeacherSalarySettingsController,
  previewTeacherSalaryController,
  generateTeacherSalaryController,
  getTeacherSalaryRunsController,
  getTeacherSalaryRunController,
  finalizeTeacherSalaryRunController,
  deleteTeacherSalaryRunController,
} = require("../../../controllers/staff/teacherSalary.controller");

// Teacher salary — Phase 2. ADMIN ONLY on every route (isAdmin resolves the
// role from the DB): managers keep their Phase 1 attendance surface and never
// see pay rates, salary amounts or run history. No Phase 1 route is altered.
teacherSalaryRouter.route("/teacher-salary/configs")
  .get(isLoggedIn, isAdmin, getTeacherPayConfigsController)
  .post(isLoggedIn, isAdmin, createTeacherPayConfigController);
teacherSalaryRouter.route("/teacher-salary/settings")
  .get(isLoggedIn, isAdmin, getTeacherSalarySettingsController)
  .put(isLoggedIn, isAdmin, updateTeacherSalarySettingsController);
teacherSalaryRouter.route("/teacher-salary/preview").post(isLoggedIn, isAdmin, previewTeacherSalaryController);
teacherSalaryRouter.route("/teacher-salary/runs")
  .get(isLoggedIn, isAdmin, getTeacherSalaryRunsController)
  .post(isLoggedIn, isAdmin, generateTeacherSalaryController);
teacherSalaryRouter.route("/teacher-salary/runs/:id")
  .get(isLoggedIn, isAdmin, getTeacherSalaryRunController)
  .delete(isLoggedIn, isAdmin, deleteTeacherSalaryRunController);
teacherSalaryRouter.route("/teacher-salary/runs/:id/finalize").put(isLoggedIn, isAdmin, finalizeTeacherSalaryRunController);

module.exports = teacherSalaryRouter;