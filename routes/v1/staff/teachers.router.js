const express = require("express");
const teachersRouter = express.Router();
//middleware
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isTeacher = require("../../../middlewares/isTeacher");
//controllers
const {
  createTeacherController,
  teacherLoginController,
  getAllTeachersController,
  getTeacherProfileController,
  updateTeacherProfileController,
  adminUpdateTeacherProfileController,
  toggleAttendanceManagerController,
  adminUpdateCredentialsController,
  adminGetTeacherController,
  deleteTeacherController,
} = require("../../../controllers/staff/teachers.controller");
// create teacher
teachersRouter
  .route("/create-teacher")
  .post(isLoggedIn, isAdminOrManager, createTeacherController);
// teacher login
teachersRouter.route("/teacher/login").post(teacherLoginController);
//get all teachers
teachersRouter
  .route("/teachers")
  .get(isLoggedIn, isAdminOrManager, getAllTeachersController);
// get teacher profile
teachersRouter
  .route("/teacher/:teacherId/profile")
  .get(isLoggedIn, isTeacher, getTeacherProfileController);
// teacher update own profile
teachersRouter
  .route("/teacher/update-profile")
  .patch(isLoggedIn, isTeacher, updateTeacherProfileController);
// admin update user profile
teachersRouter
  .route("/teacher/:teacherId/update-profile")
  .patch(isLoggedIn, isAdminOrManager, adminUpdateTeacherProfileController);
// admin toggles a teacher's attendance-manager flag
teachersRouter
  .route("/teacher/:teacherId/toggle-attendance-manager")
  .patch(isLoggedIn, isAdminOrManager, toggleAttendanceManagerController);
// admin update teacher credentials (name/email/password)
teachersRouter
  .route("/teacher/:teacherId/credentials")
  .put(isLoggedIn, isAdminOrManager, adminUpdateCredentialsController);
// admin get teacher by ID
teachersRouter
  .route("/admin/teacher/:teacherId")
  .get(isLoggedIn, isAdminOrManager, adminGetTeacherController);
// admin delete a teacher
teachersRouter
  .route("/teacher/:teacherId")
  .delete(isLoggedIn, isAdminOrManager, deleteTeacherController);
module.exports = teachersRouter;
