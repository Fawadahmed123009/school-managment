const express = require("express");
const multer = require("multer");
const marksRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isTeacher = require("../../../middlewares/isTeacher");
const isAssignedToSubject = require("../../../middlewares/isAssignedToSubject");

const {
  createMarkController,
  bulkCreateMarksController,
  getStudentTermReportController,
} = require("../../../controllers/academic/marks.controller");

const { extractMarksFromImageController } = require("../../../controllers/academic/marksOcr.controller");

const upload = multer({ dest: "uploads/" });

marksRouter.route("/marks").post(isLoggedIn, isTeacher, isAssignedToSubject, createMarkController);
marksRouter.route("/marks/bulk").post(isLoggedIn, isTeacher, isAssignedToSubject, bulkCreateMarksController);
marksRouter
  .route("/marks/student/:studentId/term/:academicTermId")
  .get(isLoggedIn, isTeacher, getStudentTermReportController);
marksRouter
  .route("/marks/ocr/extract")
  .post(isLoggedIn, isTeacher, upload.single("image"), extractMarksFromImageController);

module.exports = marksRouter;
