const express = require("express");
const academicTermRouter = express.Router();
// middleware
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const {
  getAcademicTermsController,
  createAcademicTermController,
  getAcademicTermController,
  updateAcademicTermController,
  deleteAcademicTermController,
} = require("../../../controllers/academic/academicTerm.controller");
academicTermRouter
  .route("/academic-term")
  .get(isLoggedIn, getAcademicTermsController)
  .post(isLoggedIn, isAdminOrManager, createAcademicTermController);
academicTermRouter
  .route("/academic-term/:academicTermId")
  .get(isLoggedIn, getAcademicTermController)
  .patch(isLoggedIn, isAdminOrManager, updateAcademicTermController)
  .delete(isLoggedIn, isAdminOrManager, deleteAcademicTermController);
module.exports = academicTermRouter;
