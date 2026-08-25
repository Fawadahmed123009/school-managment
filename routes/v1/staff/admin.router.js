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

// register
adminRouter
  .route("/admin/register")
  .post(isLoggedIn, isAdmin, registerAdminController);
//  login
adminRouter.route("/admin/login").post(loginAdminController);
// get all admin
adminRouter.route("/admins").get(isLoggedIn, isAdmin, getAdminsController);
//get current admin profile
adminRouter.route("/admin/profile").get(isLoggedIn, isAdmin, getAdminProfileController);
// update/delete admin
adminRouter
  .route("/admin/:adminId")
  .put(isLoggedIn, isAdmin, updateAdminController)
  .delete(isLoggedIn, isAdmin, deleteAdminController);
// admin suspend a teacher
adminRouter
  .route("/admins/suspend/teacher/:teacherId")
  .put(isLoggedIn, isAdmin, adminSuspendTeacherController);
// admin unsuspend a teacher
adminRouter
  .route("/admins/unsuspend/teacher/:teacherId")
  .put(isLoggedIn, isAdmin, adminUnSuspendTeacherController);
//  admin withdraws a teacher
adminRouter
  .route("/admins/withdraw/teacher/:teacherId")
  .put(isLoggedIn, isAdmin, adminWithdrawTeacherController);
// admin un-withdraws a teacher
adminRouter
  .route("/admins/unwithdraw/teacher/:teacherId")
  .put(isLoggedIn, isAdmin, adminUnWithdrawTeacherController);
// admin publish result
adminRouter
  .route("/admins/publish/result/:resultId")
  .put(isLoggedIn, isAdmin, adminPublishResultsController);
// admin un-publish result
adminRouter
  .route("/admins/unpublish/result/:resultId")
  .put(isLoggedIn, isAdmin, adminUnPublishResultsController);

module.exports = adminRouter;
