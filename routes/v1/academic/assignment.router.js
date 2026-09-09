const express = require("express");
const assignmentRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isTeacher = require("../../../middlewares/isTeacher");

const {
  createAssignmentController,
  getAllAssignmentsController,
  getMyAssignmentsController,
  deleteAssignmentController,
} = require("../../../controllers/academic/assignment.controller");

assignmentRouter.route("/assignments").post(isLoggedIn, isAdminOrManager, createAssignmentController);
assignmentRouter.route("/assignments").get(isLoggedIn, isAdminOrManager, getAllAssignmentsController);
assignmentRouter.route("/assignments/my").get(isLoggedIn, isTeacher, getMyAssignmentsController);
assignmentRouter.route("/assignments/:assignmentId").delete(isLoggedIn, isAdminOrManager, deleteAssignmentController);

module.exports = assignmentRouter;
