const express = require("express");
const multer = require("multer");
const fs = require("fs");
const { makeUpload, cleanupUploadedFiles, PHOTO_MAX_BYTES } = require("../../../utils/uploadFactory");
const studentsRouter = express.Router();
// Middleware
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdminOrManager = require("../../../middlewares/isAdminOrManager");
const isStudent = require("../../../middlewares/isStudent");
// Controllers
const {
  adminRegisterStudentController,
  studentLoginController,
  getStudentProfileController,
  getAllStudentsByAdminController,
  getStudentByAdminController,
  studentUpdateProfileController,
  adminUpdateStudentController,
  adminDeleteStudentController,
  updateLinkedParentController,
  addParentToStudentController,
} = require("../../../controllers/students/students.controller");
const {
  parseStudentExcelController,
  bulkCreateStudentsFromImportController,
  exportStudentsController,
} = require("../../../controllers/students/studentImport.controller");
const { getStudentAnalysisController } = require("../../../controllers/students/studentAnalysis.controller");
const { setStudentPhotoController } = require("../../../controllers/students/studentPhoto.controller");

// H5: bulk-import workbooks go through the shared sheet preset (10 MB cap, one
// file, spreadsheet type filter) and the uploaded workbook is removed when the
// response ends — including when parsing throws. See utils/uploadFactory.js.
const upload = makeUpload("sheet");

// Permanent student-photo storage (local disk under uploads/photos/, matching
// the uploads/ pattern used elsewhere — not cloud storage).
// H5: built from the shared "image" preset so the size cap and mime filter can
// no longer drift from every other upload route. NO cleanup middleware here —
// this one writes the file we keep.
const photoUpload = makeUpload("image", {
  maxBytes: PHOTO_MAX_BYTES,
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = "uploads/photos";
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // Sanitize studentId: strip anything except hex characters to prevent path traversal
      const safeId = (req.params.studentId || "unknown").replace(/[^a-fA-F0-9]/g, "");
      const ext = (file.originalname.match(/\.[a-z0-9]+$/i) || [".jpg"])[0].toLowerCase();
      // Only allow safe image extensions
      const allowedExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
      const safeExt = allowedExts.includes(ext) ? ext : ".jpg";
      cb(null, `${safeId}-${Date.now()}${safeExt}`);
    },
  }),
});

// Create Student by Admin
studentsRouter
  .route("/students/admin/register")
  .post(isLoggedIn, isAdminOrManager, adminRegisterStudentController);
// Student Login
studentsRouter.route("/students/login").post(studentLoginController);
// Get Student Profile
studentsRouter
  .route("/students/profile")
  .get(isLoggedIn, isStudent, getStudentProfileController);
// Student views own analysis (attendance + marks + fees)
studentsRouter
  .route("/students/my-analysis")
  .get(isLoggedIn, isStudent, (req, res) => {
    req.params.studentId = req.userAuth.id;
    return getStudentAnalysisController(req, res);
  });
// Get All Students by Admin
studentsRouter
  .route("/admin/students")
  .get(isLoggedIn, isAdminOrManager, getAllStudentsByAdminController);
// Get Single Student by Admin
studentsRouter
  .route("/:studentId/admin")
  .get(isLoggedIn, isAdminOrManager, getStudentByAdminController);
// Update Student Profile by Student
studentsRouter
  .route("/update")
  .patch(isLoggedIn, isStudent, studentUpdateProfileController);
// Admin Update Student Profile
studentsRouter
  .route("/:studentId/update/admin")
  .patch(isLoggedIn, isAdminOrManager, adminUpdateStudentController);
// Admin Delete Student
studentsRouter
  .route("/:studentId/delete/admin")
  .delete(isLoggedIn, isAdminOrManager, adminDeleteStudentController);
// NOTE: Old exam-write route removed — superseded by Test system (/tests/manage).
// Bulk import — parse Excel, stage rows for review
studentsRouter
  .route("/students/import/parse")
  .post(isLoggedIn, isAdminOrManager, upload.single("file"), cleanupUploadedFiles, parseStudentExcelController);
// Bulk import — confirm reviewed rows, actually create students
studentsRouter
  .route("/students/import/confirm")
  .post(isLoggedIn, isAdminOrManager, bulkCreateStudentsFromImportController);
// Export all students to Excel
studentsRouter
  .route("/students/export")
  .get(isLoggedIn, isAdminOrManager, exportStudentsController);
// Get combined analysis (attendance + marks + fees) for one student
// Admin can view any student; student can view only their own.
studentsRouter
  .route("/students/:studentId/analysis")
  .get(isLoggedIn, (req, res, next) => {
    if (req.userAuth.id === req.params.studentId) {
      return getStudentAnalysisController(req, res);
    }
    // For non-self access, require admin or manager
    return isAdminOrManager(req, res, () => getStudentAnalysisController(req, res));
  });
// Upload / replace a student's photo (native camera capture or file upload)
studentsRouter
  .route("/students/:studentId/photo")
  .post(isLoggedIn, isAdminOrManager, photoUpload.single("photo"), setStudentPhotoController);
// Update linked parent's basic info (Feature 1)
studentsRouter
  .route("/students/:studentId/update-parent")
  .post(isLoggedIn, isAdminOrManager, updateLinkedParentController);
// Add parent details to a student with no linked parent (Feature 2)
studentsRouter
  .route("/students/:studentId/add-parent")
  .post(isLoggedIn, isAdminOrManager, addParentToStudentController);

module.exports = studentsRouter;
