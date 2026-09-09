/**
 * Script: Delete ALL documents from the Fees collection.
 *
 * Produces a summary report (total records, sum of amounts, breakdown by
 * status) before touching anything, so there is a clear audit trail of
 * what was removed.
 *
 * Usage:
 *   node scripts/deleteAllFees.js            # dry-run (counts only)
 *   node scripts/deleteAllFees.js --confirm   # actually delete
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

  console.log(`\n=== Delete ALL Fees ===`);
  console.log(`Mode: ${isDryRun ? "DRY RUN (no changes)" : "LIVE (will DELETE all fee records)"}\n`);

  await mongoose.connect(dbUri);
  console.log("Connected to database.\n");

  const Fee = require("../models/Fees/fees.model");

  // ── Summary report ────────────────────────────────────────────────
  const totalRecords = await Fee.countDocuments();

  if (totalRecords === 0) {
    console.log("Fees collection is already empty. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  // Sum of all amounts
  const amountResult = await Fee.aggregate([
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const totalAmount = amountResult[0]?.total ?? 0;

  // Breakdown by status
  const statusBreakdown = await Fee.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 }, totalAmount: { $sum: "$amount" } } },
    { $sort: { _id: 1 } },
  ]);

  console.log("Current Fees collection summary:");
  console.log(`  Total records:   ${totalRecords}`);
  console.log(`  Total amount:    ${totalAmount.toLocaleString()}`);
  console.log(`\n  Breakdown by status:`);
  statusBreakdown.forEach((row) => {
    console.log(`    ${row._id ?? "(none)"}:  ${row.count} record(s), amount ${row.totalAmount.toLocaleString()}`);
  });

  // ── Execute or stop ───────────────────────────────────────────────
  if (isDryRun) {
    console.log(`\n[DRY RUN] Would delete ${totalRecords} fee record(s).`);
    console.log("Re-run with --confirm to execute the deletion.\n");
  } else {
    const result = await Fee.deleteMany({});
    console.log(`\n[DONE] Deleted ${result.deletedCount} fee record(s) from the Fees collection.`);

    // Verify
    const afterCount = await Fee.countDocuments();
    console.log(`\nPost-deletion count: ${afterCount} (should be 0)`);
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
