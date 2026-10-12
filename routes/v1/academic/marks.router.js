const express = require("express");
const { makeUpload, cleanupUploadedFiles } = require("../../../utils/uploadFactory");
const marksRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isTeacher = require("../../../middlewares/isTeacher");

const { extractMarksFromImageController } = require("../../../controllers/academic/marksOcr.controller");

// RETIRED: GET /marks/student/:studentId/term/:academicTermId
// (getStudentTermReportController -> getStudentTermReportService) plus its
// orphaned view route GET /marks/report/:studentId/:academicTermId were removed.
// They were reachable only via routeSync auto-mount, linked by no UI, untested,
// and backed by the deprecated ExamResult/Exam model with no remaining write path
// (marking now goes through TestResult via POST /tests/:testId/results and OCR).

// H5: marks-scan images go through the shared hardened upload (8 MB cap, one
// file, image type filter) and the temp copy is removed when the response ends,
// not only when the OCR path succeeds. See utils/uploadFactory.js.
const upload = makeUpload("image");

marksRouter
  .route("/marks/ocr/extract")
  .post(isLoggedIn, isTeacher, upload.single("image"), cleanupUploadedFiles, extractMarksFromImageController);

module.exports = marksRouter;
