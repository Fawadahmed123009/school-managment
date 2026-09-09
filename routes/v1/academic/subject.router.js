const express = require("express");
const subjectRouter = express.Router();
// middlewares
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isLoggedIn = require("../../../middlewares/isLoggedIn");
// controllers
const {
  getSubjectsController,
  getSubjectController,
  updateSubjectController,
  deleteSubjectController,
  createSubjectController,
} = require("../../../controllers/academic/subject.controller");

subjectRouter.route("/subject").get(isLoggedIn, isAdminOrManager, getSubjectsController);
subjectRouter
  .route("/subject/:subjectId")
  .get(isLoggedIn, isAdminOrManager, getSubjectController)
  .patch(isLoggedIn, isAdminOrManager, updateSubjectController)
  .delete(isLoggedIn, isAdminOrManager, deleteSubjectController);
subjectRouter
  .route("/create-subject/:programId")
  .post(isLoggedIn, isAdminOrManager, createSubjectController);

module.exports = subjectRouter;
