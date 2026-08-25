const express = require("express");
const parentsRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");
const isParent = require("../../../middlewares/isParent");

const {
  parentLoginController,
  getParentProfileController,
  getChildrenAnalysisController,
  getChildrenFeesController,
  createParentController,
  getAllParentsController,
  addChildToParentController,
} = require("../../../controllers/parents/parents.controller");

// ---- Parent Authentication ----
parentsRouter.route("/parents/login").post(parentLoginController);

// ---- Parent Self-Service ----
parentsRouter.route("/parents/profile").get(isLoggedIn, isParent, getParentProfileController);
parentsRouter.route("/parents/children/:childId/analysis").get(isLoggedIn, isParent, getChildrenAnalysisController);
parentsRouter.route("/parents/children/:childId/fees").get(isLoggedIn, isParent, getChildrenFeesController);

// ---- Admin: Parent Management ----
parentsRouter.route("/admin/parents").get(isLoggedIn, isAdmin, getAllParentsController);
parentsRouter.route("/admin/parents").post(isLoggedIn, isAdmin, createParentController);
parentsRouter.route("/admin/parents/:parentId/children/:childId").post(isLoggedIn, isAdmin, addChildToParentController);

module.exports = parentsRouter;
