/**
 * Migration: Backfill the TestResult absent flag for legacy absences.
 *
 * Old entry semantics stored every absence as a bare score 0 (the absent flag
 * either didn't exist or was never written). The new semantics make the flag
 * authoritative: score 0 WITHOUT the flag is now a GENUINE mark. Under the old
 * rule a typed 0 always meant absent, so no genuine zeros exist in the DB —
 * every `score: 0 && absent !== true` row is a legacy absence and gets
 * `absent: true`. This must run BEFORE deploying the new entry logic so no
 * ambiguous rows exist at the moment of cutover.
 *
 * Usage:
 *   node scripts/migrateAbsentFlag.js            # dry-run (preview only)
 *   node scripts/migrateAbsentFlag.js --confirm   # actually write changes
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

  console.log(`\n=== TestResult absent-flag backfill migration ===`);
  console.log(`Mode: ${isDryRun ? "DRY RUN (no changes)" : "LIVE (will write changes)"}\n`);

  await mongoose.connect(dbUri);
  console.log("Connected to database.\n");

  const TestResult = require("../models/Academic/testResult.model");
  // Register the models the sample populate below resolves refs against —
  // omitting either throws MissingSchemaError at runtime.
  require("../models/Academic/test.model");
  require("../models/Students/students.model");

  const total = await TestResult.countDocuments();
  const alreadyAbsent = await TestResult.countDocuments({ absent: true });
  const legacyAbsences = await TestResult.countDocuments({ score: 0, absent: { $ne: true } });
  const nonZero = await TestResult.countDocuments({ score: { $gt: 0 } });

  console.log("Current state:");
  console.log(`  Total TestResult rows:              ${total}`);
  console.log(`  absent = true:                      ${alreadyAbsent}`);
  console.log(`  score 0, absent not true (→ flag):  ${legacyAbsences}`);
  console.log(`  score > 0:                          ${nonZero}`);

  // Sanity: rows with a missing/undefined absent field — expected to be 0 for
  // docs created after the flag shipped (Mongoose defaults it to false).
  const missingFlag = await TestResult.countDocuments({ absent: { $exists: false } });
  if (missingFlag > 0) {
    console.log(`  absent field missing entirely:       ${missingFlag} (will be set too)`);
  }

  if (legacyAbsences === 0) {
    console.log("\nNothing to migrate — no legacy score-0 rows without the flag. All done.");
    await mongoose.disconnect();
    return;
  }

  // Show a sample of affected rows so the operator can eyeball the scope.
  const sample = await TestResult.find({ score: 0, absent: { $ne: true } })
    .select("test student absent createdAt")
    .populate("student", "name")
    .populate("test", "name")
    .limit(10)
    .lean();

  console.log(`\nSample legacy absence rows (showing up to 10):`);
  sample.forEach((r) => {
    const stu = r.student ? r.student.name : "?";
    const tst = r.test ? r.test.name : "?";
    console.log(`  - ${stu} — test "${tst}" (absent: ${r.absent === undefined ? "missing" : r.absent}, created ${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "?"})`);
  });
  if (legacyAbsences > 10) console.log(`  ... and ${legacyAbsences - 10} more`);

  if (isDryRun) {
    console.log(`\n[DRY RUN] Would set absent:true on ${legacyAbsences} row(s).`);
    console.log("Re-run with --confirm to execute.\n");
  } else {
    const result = await TestResult.updateMany(
      { score: 0, absent: { $ne: true } },
      { $set: { absent: true } }
    );
    console.log(`\n[DONE] Flagged ${result.modifiedCount} row(s) as absent.`);

    // Verify: the invariant readers now rely on — no score-0 row lacks the flag.
    const after = await TestResult.countDocuments({ score: 0, absent: { $ne: true } });
    const afterAbsent = await TestResult.countDocuments({ absent: true });
    console.log(`\nPost-migration state:`);
    console.log(`  score 0, absent not true: ${after} (must be 0)`);
    console.log(`  absent = true total:      ${afterAbsent}`);
    if (after !== 0) {
      console.error("WARNING: rows still match the legacy pattern — re-run the migration.");
      process.exitCode = 1;
    }
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
