/**
 * Script: Full database reset — deletes ALL documents from every collection.
 *
 * Collections cleared:
 *   Student, Parent, Teacher, Admin, ClassLevel, Program, Subject,
 *   Assignment, Fees, FeeHead, Test, TestSession, TestResult,
 *   Attendance, AcademicTerm, AcademicYear, Exam, Question,
 *   Result, YearGroup
 *
 * Usage:
 *   node scripts/fullReset.js            # dry-run (counts only)
 *   node scripts/fullReset.js --confirm   # actually delete everything
 *
 * Environment:
 *   Uses process.env.DB for the MongoDB connection string.
 */

require("dotenv").config();
const mongoose = require("mongoose");

const COLLECTIONS = [
  { name: "Student",      path: "../models/Students/students.model" },
  { name: "Parent",       path: "../models/Parents/parents.model" },
  { name: "Teacher",      path: "../models/Staff/teachers.model" },
  { name: "Admin",        path: "../models/Staff/admin.model" },
  { name: "ClassLevel",   path: "../models/Academic/class.model" },
  { name: "Program",      path: "../models/Academic/program.model" },
  { name: "Subject",      path: "../models/Academic/subject.model" },
  { name: "Assignment",   path: "../models/Academic/assignment.model" },
  { name: "Fees",         path: "../models/Fees/fees.model" },
  { name: "FeeHead",      path: "../models/Fees/feeHead.model" },
  { name: "Test",         path: "../models/Academic/test.model" },
  { name: "TestSession",  path: "../models/Academic/testSession.model" },
  { name: "TestResult",   path: "../models/Academic/testResult.model" },
  { name: "Attendance",   path: "../models/Academic/attendance.model" },
  { name: "AcademicTerm", path: "../models/Academic/academicTerm.model" },
  { name: "AcademicYear", path: "../models/Academic/academicYear.model" },
  { name: "Exam",         path: "../models/Academic/exams.model" },
  { name: "Question",     path: "../models/Academic/questions.model" },
  { name: "Result",       path: "../models/Academic/results.model" },
  { name: "YearGroup",    path: "../models/Academic/yearGroup.model" },
];

function ts() {
  return new Date().toISOString();
}

async function main() {
  const isDryRun = !process.argv.includes("--confirm");
  const dbUri = process.env.DB;

  if (!dbUri) {
    console.error("ERROR: process.env.DB is not set. Add it to your .env file.");
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  FULL DATABASE RESET`);
  console.log(`${"=".repeat(60)}`);
  console.log(`[${ts()}] Mode: ${isDryRun ? "DRY RUN (no changes)" : "LIVE — WILL DELETE EVERYTHING"}`);
  console.log(`[${ts()}] Connecting to database...\n`);

  await mongoose.connect(dbUri);
  console.log(`[${ts()}] Connected.\n`);

  // Load all models
  const models = COLLECTIONS.map((c) => {
    const Model = require(c.path);
    return { name: c.name, Model };
  });

  // ── Phase 1: Count every collection ──────────────────────────────
  console.log(`[${ts()}] ── Current document counts ──`);
  let grandTotal = 0;
  const counts = [];

  for (const { name, Model } of models) {
    const count = await Model.countDocuments();
    counts.push({ name, Model, count });
    grandTotal += count;
    console.log(`  ${name.padEnd(16)} ${count}`);
  }

  console.log(`  ${"".padEnd(16)} ──────`);
  console.log(`  ${"TOTAL".padEnd(16)} ${grandTotal}\n`);

  if (grandTotal === 0) {
    console.log(`[${ts()}] Database is already completely empty. Nothing to do.`);
    await mongoose.disconnect();
    return;
  }

  // ── Phase 2: Delete or stop ──────────────────────────────────────
  if (isDryRun) {
    console.log(`[${ts()}] [DRY RUN] Would delete ${grandTotal} document(s) across ${models.length} collection(s).`);
    console.log(`[${ts()}] Re-run with --confirm to execute the deletion.\n`);
  } else {
    console.log(`[${ts()}] *** DELETING ALL DOCUMENTS ***\n`);

    for (const { name, Model } of counts) {
      if (counts.find((c) => c.name === name).count === 0) continue;
      const result = await Model.deleteMany({});
      console.log(`  [${ts()}] ${name.padEnd(16)} deleted ${result.deletedCount} document(s)`);
    }

    // ── Phase 3: Verification ──────────────────────────────────────
    console.log(`\n[${ts()}] ── Post-deletion verification ──`);
    let allEmpty = true;

    for (const { name, Model } of models) {
      const after = await Model.countDocuments();
      const status = after === 0 ? "OK" : "NOT EMPTY";
      if (after !== 0) allEmpty = false;
      console.log(`  ${name.padEnd(16)} ${String(after).padStart(6)}  [${status}]`);
    }

    console.log("");
    if (allEmpty) {
      console.log(`[${ts()}] [DONE] All ${models.length} collections are now empty (0 documents each).`);
      console.log(`[${ts()}] Database has been fully reset. No seed data was created.`);
    } else {
      console.log(`[${ts()}] [WARNING] Some collections still have documents — investigate manually.`);
    }
  }

  await mongoose.disconnect();
  console.log(`\n[${ts()}] Disconnected from database. Done.`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
