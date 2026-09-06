const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Student = require("../../models/Students/students.model");
const responseStatus = require("../../handlers/responseStatus.handler");

// Resize + recompress the uploaded photo using sharp.
// Max 600x600 (fit inside, no upscaling), JPEG quality 70.
// Targets ~20-50 KB for typical student photos.
// Both camera-capture and file-upload paths converge here, so this single
// function covers every entry point.
//
// Sharp cannot read from and write to the identical file path in one
// operation, so we always process into a temporary file first, then
// atomically swap it into place.
const compressPhoto = async (filePath) => {
  const parsed = path.parse(filePath);
  const jpgPath = path.join(parsed.dir, `${parsed.name}.jpg`);
  const tmpPath = `${jpgPath}.tmp`;

  try {
    await sharp(filePath)
      .resize({ width: 600, height: 600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(tmpPath);

    // Remove the original upload (it may be the same path as jpgPath when
    // the file was already .jpg — the temp-file strategy avoids the
    // "Cannot use same file for input and output" sharp error).
    if (filePath !== tmpPath) {
      try { await fs.promises.unlink(filePath); } catch (_) { /* best-effort */ }
    }

    // Move temp file to the final destination
    await fs.promises.rename(tmpPath, jpgPath);
  } catch (err) {
    // Clean up the temp file on failure
    try { await fs.promises.unlink(tmpPath); } catch (_) { /* ignore */ }
    throw err;
  }

  return jpgPath;
};

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

  // Compress / resize the photo on disk before persisting the URL
  const compressedPath = await compressPhoto(file.path);
  const compressedFilename = path.basename(compressedPath);

  const photoUrl = `/uploads/photos/${compressedFilename}`;
  const previous = student.photoUrl;

  if (previous && previous.startsWith("/uploads/photos/")) {
    fs.unlink(path.join(process.cwd(), previous), () => {});
  }

  student.photoUrl = photoUrl;
  await Student.findByIdAndUpdate(studentId, { photoUrl });

  return responseStatus(res, 200, "success", { photoUrl });
};
