const fs = require("fs");
const path = require("path");

let sharp;
try {
  sharp = require("sharp");
} catch (_) {
  // sharp native binary unavailable — photo compression will be skipped
}
const Student = require("../../models/Students/students.model");
const responseStatus = require("../../handlers/responseStatus.handler");
const { uploadToR2, deleteFromR2, saveLocally, isR2Configured } = require("../../utils/r2Client");

// Resize + recompress the uploaded photo using sharp.
// Max 600x600 (fit inside, no upscaling), JPEG quality 70.
// Targets ~20-50 KB for typical student photos.
const compressPhoto = async (filePath) => {
  // If sharp failed to load, skip compression and return the original file
  if (!sharp) return filePath;

  const parsed = path.parse(filePath);
  const jpgPath = path.join(parsed.dir, `${parsed.name}.jpg`);
  const tmpPath = `${jpgPath}.tmp`;

  try {
    await sharp(filePath)
      .resize({ width: 600, height: 600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(tmpPath);

    if (filePath !== tmpPath) {
      try { await fs.promises.unlink(filePath); } catch (_) { /* best-effort */ }
    }
    await fs.promises.rename(tmpPath, jpgPath);
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch (_) { /* ignore */ }
    throw err;
  }

  return jpgPath;
};

// Called from the API route after multer diskStorage has saved the photo to
// uploads/photos/. Uploads to Cloudflare R2 if configured, otherwise stores
// the relative URL locally.
exports.setStudentPhotoService = async (studentId, file, res) => {
  if (!file) {
    return responseStatus(res, 400, "failed", "No image provided");
  }

  const student = await Student.findById(studentId);
  if (!student) {
    fs.unlink(file.path, () => {});
    return responseStatus(res, 404, "failed", "Student not found");
  }

  // Compress / resize the photo on disk first
  const compressedPath = await compressPhoto(file.path);
  const compressedFilename = path.basename(compressedPath);

  let photoUrl;

  if (isR2Configured()) {
    // Upload compressed file to R2
    const buffer = await fs.promises.readFile(compressedPath);
    const key = `photos/${compressedFilename}`;
    photoUrl = await uploadToR2(key, buffer, "image/jpeg");
    // Clean up local compressed file
    fs.promises.unlink(compressedPath).catch(() => {});

    // Best-effort delete previous R2 photo
    if (student.photoUrl && student.photoUrl.includes("r2.cloudflarestorage.com") || (student.photoUrl && student.photoUrl.startsWith(process.env.R2_PUBLIC_URL || "https://never"))) {
      deleteFromR2(student.photoUrl).catch(() => {});
    }
  } else {
    // Fallback: local disk storage
    photoUrl = `/uploads/photos/${compressedFilename}`;

    // Best-effort remove previous local photo
    const previous = student.photoUrl;
    if (previous && previous.startsWith("/uploads/photos/")) {
      fs.unlink(path.join(process.cwd(), previous), () => {});
    }
  }

  await Student.findByIdAndUpdate(studentId, { photoUrl });

  return responseStatus(res, 200, "success", { photoUrl });
};
