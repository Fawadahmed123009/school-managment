const express = require("express");
const classRouter = express.Router();
// middleware
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isLoggedIn = require("../../../middlewares/isLoggedIn");
// controllers
const {
  getClassLevelsController,
  createClassLevelController,
  getClassLevelController,
  updateClassLevelController,
  deleteClassLevelController,
} = require("../../../controllers/academic/class.controller");
classRouter
  .route("/class-levels")
  .get(isLoggedIn, getClassLevelsController)
  .post(isLoggedIn, isAdminOrManager, createClassLevelController);
classRouter
  .route("/class-levels/:classLevelId")
  .get(isLoggedIn, getClassLevelController)
  .patch(isLoggedIn, isAdminOrManager, updateClassLevelController)
  .delete(isLoggedIn, isAdminOrManager, deleteClassLevelController);
module.exports = classRouter;
