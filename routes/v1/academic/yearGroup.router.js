const express = require("express");
const yearGroupRouter = express.Router();
// middlewares
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isLoggedIn = require("../../../middlewares/isLoggedIn");
// controller
const {
  getYearGroupsController,
  createYearGroupController,
  getYearGroupController,
  updateYearGroupController,
  deleteYearGroupController,
} = require("../../../controllers/academic/yearGroup.controller");

yearGroupRouter
  .route("/year-group")
  .get(isLoggedIn, isAdminOrManager, getYearGroupsController)
  .post(isLoggedIn, isAdminOrManager, createYearGroupController);

yearGroupRouter
  .route("/year-group/:yearGroupId")
  .get(isLoggedIn, isAdminOrManager, getYearGroupController)
  .patch(isLoggedIn, isAdminOrManager, updateYearGroupController)
  .delete(isLoggedIn, isAdminOrManager, deleteYearGroupController);

module.exports = yearGroupRouter;
