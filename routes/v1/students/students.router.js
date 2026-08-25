const express = require("express");
const multer = require("multer");
const fs = require("fs");
const studentsRouter = express.Router();
// Middleware
const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");
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
} = require("../../../controllers/students/students.controller");
const {
  parseStudentExcelController,
  bulkCreateStudentsFromImportController,
  exportStudentsController,
} = require("../../../controllers/students/studentImport.controller");
const { getStudentAnalysisController } = require("../../../controllers/students/studentAnalysis.controller");
const { setStudentPhotoController } = require("../../../controllers/students/studentPhoto.controller");

const upload = multer({ dest: "uploads/" });

// Permanent student-photo storage (local disk under uploads/photos/, matching
// the uploads/ pattern used elsewhere — not cloud storage).
const photoUpload = multer({
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
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(null, false);
    cb(null, true);
  },
  limits: { fileSize: 8 * 1024 * 1024 },
});

// Create Student by Admin
studentsRouter
  .route("/students/admin/register")
  .post(isLoggedIn, isAdmin, adminRegisterStudentController);
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
  .get(isLoggedIn, isAdmin, getAllStudentsByAdminController);
// Get Single Student by Admin
studentsRouter
  .route("/:studentId/admin")
  .get(isLoggedIn, isAdmin, getStudentByAdminController);
// Update Student Profile by Student
studentsRouter
  .route("/update")
  .patch(isLoggedIn, isStudent, studentUpdateProfileController);
// Admin Update Student Profile
studentsRouter
  .route("/:studentId/update/admin")
  .patch(isLoggedIn, isAdmin, adminUpdateStudentController);
// Admin Delete Student
studentsRouter
  .route("/:studentId/delete/admin")
  .delete(isLoggedIn, isAdmin, adminDeleteStudentController);
// NOTE: Old exam-write route removed — superseded by Test system (/tests/manage).
// Bulk import — parse Excel, stage rows for review
studentsRouter
  .route("/students/import/parse")
  .post(isLoggedIn, isAdmin, upload.single("file"), parseStudentExcelController);
// Bulk import — confirm reviewed rows, actually create students
studentsRouter
  .route("/students/import/confirm")
  .post(isLoggedIn, isAdmin, bulkCreateStudentsFromImportController);
// Export all students to Excel
studentsRouter
  .route("/students/export")
  .get(isLoggedIn, isAdmin, exportStudentsController);
// Get combined analysis (attendance + marks + fees) for one student
// Admin can view any student; student can view only their own.
studentsRouter
  .route("/students/:studentId/analysis")
  .get(isLoggedIn, (req, res, next) => {
    if (req.userAuth.id === req.params.studentId) {
      return getStudentAnalysisController(req, res);
    }
    // For non-self access, require admin
    return isAdmin(req, res, () => getStudentAnalysisController(req, res));
  });
// Upload / replace a student's photo (native camera capture or file upload)
studentsRouter
  .route("/students/:studentId/photo")
  .post(isLoggedIn, isAdmin, photoUpload.single("photo"), setStudentPhotoController);

module.exports = studentsRouter;
