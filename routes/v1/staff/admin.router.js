const express = require("express");
const {
  registerAdminController,
  loginAdminController,
  getAdminsController,
  updateAdminController,
  deleteAdminController,
  adminSuspendTeacherController,
  adminUnSuspendTeacherController,
  adminWithdrawTeacherController,
  adminUnWithdrawTeacherController,
  adminPublishResultsController,
  adminUnPublishResultsController,
  getAdminProfileController,
} = require("../../../controllers/staff/admin.controller");
const adminRouter = express.Router();
// middleware
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");

// register
adminRouter
  .route("/admin/register")
  .post(isLoggedIn, isAdminOrManager, registerAdminController);
//  login
adminRouter.route("/admin/login").post(loginAdminController);
// get all admin
adminRouter.route("/admins").get(isLoggedIn, isAdminOrManager, getAdminsController);
//get current admin profile
adminRouter.route("/admin/profile").get(isLoggedIn, isAdminOrManager, getAdminProfileController);
// update/delete admin
adminRouter
  .route("/admin/:adminId")
  .put(isLoggedIn, isAdminOrManager, updateAdminController)
  .delete(isLoggedIn, isAdminOrManager, deleteAdminController);
// admin suspend a teacher
adminRouter
  .route("/admins/suspend/teacher/:teacherId")
  .put(isLoggedIn, isAdminOrManager, adminSuspendTeacherController);
// admin unsuspend a teacher
adminRouter
  .route("/admins/unsuspend/teacher/:teacherId")
  .put(isLoggedIn, isAdminOrManager, adminUnSuspendTeacherController);
//  admin withdraws a teacher
adminRouter
  .route("/admins/withdraw/teacher/:teacherId")
  .put(isLoggedIn, isAdminOrManager, adminWithdrawTeacherController);
// admin un-withdraws a teacher
adminRouter
  .route("/admins/unwithdraw/teacher/:teacherId")
  .put(isLoggedIn, isAdminOrManager, adminUnWithdrawTeacherController);
// admin publish result
adminRouter
  .route("/admins/publish/result/:resultId")
  .put(isLoggedIn, isAdminOrManager, adminPublishResultsController);
// admin un-publish result
adminRouter
  .route("/admins/unpublish/result/:resultId")
  .put(isLoggedIn, isAdminOrManager, adminUnPublishResultsController);

module.exports = adminRouter;
