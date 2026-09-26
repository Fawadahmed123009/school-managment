const express = require("express");
const { makeUpload, cleanupUploadedFiles } = require("../../../utils/uploadFactory");
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

// H5: marks-scan images go through the shared hardened upload (8 MB cap, one
// file, image type filter) and the temp copy is removed when the response ends,
// not only when the OCR path succeeds. See utils/uploadFactory.js.
const upload = makeUpload("image");

marksRouter.route("/marks").post(isLoggedIn, isTeacher, isAssignedToSubject, createMarkController);
marksRouter.route("/marks/bulk").post(isLoggedIn, isTeacher, isAssignedToSubject, bulkCreateMarksController);
marksRouter
  .route("/marks/student/:studentId/term/:academicTermId")
  .get(isLoggedIn, isTeacher, getStudentTermReportController);
marksRouter
  .route("/marks/ocr/extract")
  .post(isLoggedIn, isTeacher, upload.single("image"), cleanupUploadedFiles, extractMarksFromImageController);

module.exports = marksRouter;
