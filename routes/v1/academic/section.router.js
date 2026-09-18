const express = require("express");
const sectionRouter = express.Router();
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const {
  getSectionsController,
  createSectionController,
  getSectionController,
  updateSectionController,
  toggleSectionActiveController,
  deleteSectionController,
} = require("../../../controllers/academic/section.controller");

sectionRouter
  .route("/sections")
  .get(isLoggedIn, isAdminOrManager, getSectionsController)
  .post(isLoggedIn, isAdminOrManager, createSectionController);

sectionRouter
  .route("/sections/:sectionId")
  .get(isLoggedIn, isAdminOrManager, getSectionController)
  .patch(isLoggedIn, isAdminOrManager, updateSectionController)
  .delete(isLoggedIn, isAdminOrManager, deleteSectionController);

sectionRouter
  .route("/sections/:sectionId/toggle-active")
  .patch(isLoggedIn, isAdminOrManager, toggleSectionActiveController);

module.exports = sectionRouter;
