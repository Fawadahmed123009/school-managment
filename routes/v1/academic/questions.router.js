const express = require("express");
const questionsRouter = express.Router();
//middleware
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isTeacher = require("../../../middlewares/isTeacher");
const isAssignedToQuestionExam = require("../../../middlewares/isAssignedToQuestionExam");
const {
  createQuestionsController,
  getAllQuestionsController,
  getQuestionByIdController,
  updateQuestionController,
} = require("../../../controllers/academic/questions.controller");

questionsRouter
  .route("/question")
  .get(isLoggedIn, isTeacher, getAllQuestionsController);
questionsRouter
  .route("/questions/:examId/create")
  .post(isLoggedIn, isTeacher, isAssignedToQuestionExam, createQuestionsController);
questionsRouter
  .route("/question/:questionId")
  .get(isLoggedIn, isTeacher, isAssignedToQuestionExam, getQuestionByIdController)
  .patch(isLoggedIn, isTeacher, isAssignedToQuestionExam, updateQuestionController);

module.exports = questionsRouter;
