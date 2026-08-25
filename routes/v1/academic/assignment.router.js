const express = require("express");
const assignmentRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");
const isTeacher = require("../../../middlewares/isTeacher");

const {
  createAssignmentController,
  getAllAssignmentsController,
  getMyAssignmentsController,
  deleteAssignmentController,
} = require("../../../controllers/academic/assignment.controller");

assignmentRouter.route("/assignments").post(isLoggedIn, isAdmin, createAssignmentController);
assignmentRouter.route("/assignments").get(isLoggedIn, isAdmin, getAllAssignmentsController);
assignmentRouter.route("/assignments/my").get(isLoggedIn, isTeacher, getMyAssignmentsController);
assignmentRouter.route("/assignments/:assignmentId").delete(isLoggedIn, isAdmin, deleteAssignmentController);

module.exports = assignmentRouter;
