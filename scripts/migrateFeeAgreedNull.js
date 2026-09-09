/**
 * Migration: Change feeAgreed default from 0 to null.
 *
 * Existing student records with feeAgreed: 0 are treated as "never set"
 * (legacy schema default) and migrated to null.
 *
 * Usage:
 *   node scripts/migrateFeeAgreedNull.js            # dry-run (preview only)
 *   node scripts/migrateFeeAgreedNull.js --confirm   # actually write changes
 *
 * Environment:
 *   Uses process.env.DB for the MongoDB connection string.
 */

require("dotenv").config();
const mongoose = require("mongoose");

async function main() {
  const isDryRun = !process.argv.includes("--confirm");
  const dbUri = process.env.DB;

  if (!dbUri) {
    console.error("ERROR: process.env.DB is not set. Add it to your .env file.");
    process.exit(1);
  }

  console.log(`\n=== feeAgreed 0 → null migration ===`);
  console.log(`Mode: ${isDryRun ? "DRY RUN (no changes)" : "LIVE (will write changes)"}\n`);

  await mongoose.connect(dbUri);
  console.log("Connected to database.\n");

  const Student = require("../models/Students/students.model");

  // Count records with feeAgreed: 0
  const countZero = await Student.countDocuments({ feeAgreed: 0 });
  const countNull = await Student.countDocuments({
    $or: [{ feeAgreed: null }, { feeAgreed: { $exists: false } }],
  });
  const countSet = await Student.countDocuments({
    feeAgreed: { $exists: true, $ne: 0, $ne: null },
  });
  const totalStudents = await Student.countDocuments();

  console.log("Current state:");
  console.log(`  Total students:           ${totalStudents}`);
  console.log(`  feeAgreed = 0 (→ null):   ${countZero}`);
  console.log(`  feeAgreed = null/missing:  ${countNull}`);
  console.log(`  feeAgreed = explicit #>0:  ${countSet}`);

  if (countZero === 0) {
    console.log("\nNothing to migrate. All done.");
    await mongoose.disconnect();
    return;
  }

  // Show a sample of affected students
  const sample = await Student.find({ feeAgreed: 0 })
    .select("name rollNumber feeAgreed")
    .limit(10)
    .lean();

  console.log(`\nSample students with feeAgreed = 0 (showing up to 10):`);
  sample.forEach((s) => {
    console.log(`  - ${s.name} (roll #${s.rollNumber}, feeAgreed: ${s.feeAgreed})`);
  });
  if (countZero > 10) {
    console.log(`  ... and ${countZero - 10} more`);
  }

  if (isDryRun) {
    console.log(`\n[DRY RUN] Would migrate ${countZero} record(s) from feeAgreed: 0 → null.`);
    console.log("Re-run with --confirm to execute.\n");
  } else {
    const result = await Student.updateMany(
      { feeAgreed: 0 },
      { $set: { feeAgreed: null } }
    );
    console.log(`\n[DONE] Migrated ${result.modifiedCount} record(s) from feeAgreed: 0 → null.`);

    // Verify
    const afterZero = await Student.countDocuments({ feeAgreed: 0 });
    const afterNull = await Student.countDocuments({
      $or: [{ feeAgreed: null }, { feeAgreed: { $exists: false } }],
    });
    console.log(`\nPost-migration state:`);
    console.log(`  feeAgreed = 0:          ${afterZero}`);
    console.log(`  feeAgreed = null/missing: ${afterNull}`);
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
