/**
 * One-time migration: upload existing local student photos to Cloudflare R2.
 *
 * Prerequisites:
 *   1. Set R2_* env vars in .env (see .env.example).
 *   2. Install the AWS SDK:  npm install @aws-sdk/client-s3
 *   3. Run:  node scripts/migratePhotosToR2.js
 *
 * What it does:
 *   - Finds every student whose photoUrl starts with "/uploads/photos/"
 *     (i.e. a local file path).
 *   - Reads the local file, uploads it to R2 under the key "photos/<filename>".
 *   - Updates the student's photoUrl to the R2 public URL.
 *   - Optionally deletes the local file after successful upload (--delete).
 *
 * Safe to re-run: students already pointing to R2 URLs are skipped.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const Student = require("../models/Students/students.model");
const { uploadToR2, deleteFromR2, isR2Configured } = require("../utils/r2Client");

const MONGO_URI = process.env.DB;
const DELETE_LOCAL = process.argv.includes("--delete");

async function main() {
  if (!isR2Configured()) {
    console.error("ERROR: R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME in .env");
    process.exit(1);
  }

  if (!MONGO_URI) {
    console.error("ERROR: DB environment variable is not set.");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB.\n");

  // Find students with local photo URLs
  const students = await Student.find({
    photoUrl: { $regex: "^/uploads/photos/" },
  });

  if (students.length === 0) {
    console.log("No students with local photos found. Nothing to migrate.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${students.length} student(s) with local photos.\n`);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const student of students) {
    const localPath = path.join(process.cwd(), student.photoUrl);
    const filename = path.basename(localPath);
    const key = `photos/${filename}`;

    // Check if local file exists
    if (!fs.existsSync(localPath)) {
      console.log(`  SKIP  ${student.name} — local file not found: ${localPath}`);
      skipped++;
      continue;
    }

    try {
      const buffer = fs.readFileSync(localPath);
      const contentType = filename.endsWith(".png") ? "image/png" : "image/jpeg";
      const publicUrl = await uploadToR2(key, buffer, contentType);

      // Update student record
      await Student.findByIdAndUpdate(student._id, { photoUrl: publicUrl });

      console.log(`  OK    ${student.name} → ${publicUrl}`);
      migrated++;

      // Optionally delete local file
      if (DELETE_LOCAL) {
        fs.unlinkSync(localPath);
        console.log(`        Deleted local file: ${localPath}`);
      }
    } catch (err) {
      console.error(`  FAIL  ${student.name} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n── Migration complete ──`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);

  if (DELETE_LOCAL && migrated > 0) {
    console.log(`\n  Local files for migrated photos have been deleted.`);
  } else if (migrated > 0) {
    console.log(`\n  Local files preserved. Re-run with --delete to remove them:`);
    console.log(`    node scripts/migratePhotosToR2.js --delete`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
