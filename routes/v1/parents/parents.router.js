const express = require("express");
const parentsRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isParent = require("../../../middlewares/isParent");

const {
  parentLoginController,
  getParentProfileController,
  getChildrenAnalysisController,
  getChildrenFeesController,
  createParentController,
  getAllParentsController,
  addChildToParentController,
  changeParentPasswordController,
  adminResetParentPasswordController,
} = require("../../../controllers/parents/parents.controller");

// ---- Parent Authentication ----
parentsRouter.route("/parents/login").post(parentLoginController);

// ---- Parent Self-Service ----
parentsRouter.route("/parents/profile").get(isLoggedIn, isParent, getParentProfileController);
parentsRouter.route("/parents/change-password").post(isLoggedIn, isParent, changeParentPasswordController);
parentsRouter.route("/parents/children/:childId/analysis").get(isLoggedIn, isParent, getChildrenAnalysisController);
parentsRouter.route("/parents/children/:childId/fees").get(isLoggedIn, isParent, getChildrenFeesController);

// ---- Admin: Parent Management ----
parentsRouter.route("/admin/parents").get(isLoggedIn, isAdminOrManager, getAllParentsController);
parentsRouter.route("/admin/parents").post(isLoggedIn, isAdminOrManager, createParentController);
parentsRouter.route("/admin/parents/:parentId/children/:childId").post(isLoggedIn, isAdminOrManager, addChildToParentController);
parentsRouter.route("/admin/students/:studentId/reset-parent-password").post(isLoggedIn, isAdminOrManager, adminResetParentPasswordController);

module.exports = parentsRouter;
