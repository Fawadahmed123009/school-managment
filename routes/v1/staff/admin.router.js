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
const isAdmin = require("../../../middlewares/isAdmin");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");

// register
// C1: admin-account management is full-admin only — managers must never
// create, edit, or delete admin accounts.
adminRouter
  .route("/admin/register")
  .post(isLoggedIn, isAdmin, registerAdminController);
//  login
adminRouter.route("/admin/login").post(loginAdminController);
// get all admin
adminRouter.route("/admins").get(isLoggedIn, isAdminOrManager, getAdminsController);
//get current admin profile
adminRouter.route("/admin/profile").get(isLoggedIn, isAdminOrManager, getAdminProfileController);
// update/delete admin
// C1: admin-account management is full-admin only (no manager access).
adminRouter
  .route("/admin/:adminId")
  .put(isLoggedIn, isAdmin, updateAdminController)
  .delete(isLoggedIn, isAdmin, deleteAdminController);
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
