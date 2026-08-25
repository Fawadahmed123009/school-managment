const fs = require("fs");
const path = require("path");
const Student = require("../../models/Students/students.model");
const responseStatus = require("../../handlers/responseStatus.handler");

// Called from the API route after multer diskStorage has saved the photo to
// uploads/photos/. Persists photoUrl on the student and best-effort removes a
// previous local photo so re-captures don't orphan files on disk.
exports.setStudentPhotoService = async (studentId, file, res) => {
  if (!file) {
    return responseStatus(res, 400, "failed", "No image provided");
  }

  const student = await Student.findById(studentId);
  if (!student) {
    fs.unlink(file.path, () => {});
    return responseStatus(res, 404, "failed", "Student not found");
  }

  const photoUrl = `/uploads/photos/${file.filename}`;
  const previous = student.photoUrl;

  if (previous && previous.startsWith("/uploads/photos/")) {
    fs.unlink(path.join(process.cwd(), previous), () => {});
  }

  student.photoUrl = photoUrl;
  await Student.findByIdAndUpdate(studentId, { photoUrl });

  return responseStatus(res, 200, "success", { photoUrl });
};
