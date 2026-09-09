const express = require("express");
const programRouter = express.Router();
// middleware
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const {
  getProgramsController,
  createProgramController,
  getProgramController,
  updateProgramController,
  deleteProgramController,
} = require("../../../controllers/academic/program.controller");
// controllers
programRouter
  .route("/programs")
  .get(isLoggedIn, isAdminOrManager, getProgramsController)
  .post(isLoggedIn, isAdminOrManager, createProgramController);
programRouter
  .route("/programs/:programId")
  .get(isLoggedIn, isAdminOrManager, getProgramController)
  .patch(isLoggedIn, isAdminOrManager, updateProgramController)
  .delete(isLoggedIn, isAdminOrManager, deleteProgramController);

module.exports = programRouter;
