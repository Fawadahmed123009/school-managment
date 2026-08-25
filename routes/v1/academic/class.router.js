const express = require("express");
const classRouter = express.Router();
// middleware
const isAdmin = require("../../../middlewares/isAdmin");
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
  .post(isLoggedIn, isAdmin, createClassLevelController);
classRouter
  .route("/class-levels/:classLevelId")
  .get(isLoggedIn, getClassLevelController)
  .patch(isLoggedIn, isAdmin, updateClassLevelController)
  .delete(isLoggedIn, isAdmin, deleteClassLevelController);
module.exports = classRouter;
