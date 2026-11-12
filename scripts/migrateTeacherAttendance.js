/**
 * Migration: Teacher (staff) attendance — Phase 1 foundation.
 *
 * ADDITIVE ONLY. Creates two NEW collections and nothing else:
 *   • teacherattendances         — one arrival/departure record per teacher/day
 *   • teacherattendancesettings  — singleton late-arrival rule (disabled by default)
 * No existing collection, document, field or index is read-modified, altered
 * or dropped by the "up" path.
 *
 * The rule update adds per-field provenance (arrivalSource/departureSource —
 * login/logout capture vs manager correction) to teacherattendances. Those
 * are plain optional document fields (no schema/storage change): records
 * written before them read as "manual", which is exactly right.
 *
 * The staff-profile prerequisite adds optional expectedArrivalTime /
 * expectedDepartureTime (HH:MM strings) to TEACHERS. Also a plain optional
 * field: NO migration step exists for it — old docs simply lack it (""),
 * which the attendance service reads as "late detection skipped". Nothing
 * in the teachers collection is read-modified by any part of this migration.
 * (Lateness now compares each teacher's own expected arrival time; the
 * legacy graceMinutes 0 → 5 upgrade below remains the only WRITE.)
 *
 * REVERSIBLE. --rollback drops ONLY the two collections above (never anything
 * else), so the feature can be removed cleanly if needed.
 *
 * USAGE:
 *   node scripts/migrateTeacherAttendance.js                        # dry-run preview (default)
 *   node scripts/migrateTeacherAttendance.js --confirm              # apply (idempotent)
 *   node scripts/migrateTeacherAttendance.js --rollback             # dry-run rollback preview
 *   node scripts/migrateTeacherAttendance.js --rollback --confirm   # drop the two NEW collections
 *
 * SAFETY:
 *   - Test on staging/local first (point DB at a non-production database).
 *   - Take a manual DB backup before running --confirm on production.
 *   - Both paths are idempotent: re-running never duplicates data or indexes.
 *
 * Environment: uses process.env.DB for the MongoDB connection string.
 */

require("dotenv").config();
const mongoose = require("mongoose");

// The ONLY collections this migration may ever create or drop.
const ATTENDANCE_COL = "teacherattendances";
const SETTINGS_COL = "teacherattendancesettings";

// Mirrors SETTINGS_DEFAULTS in services/staff/teacherAttendance.service.js
// and the schema defaults in models/Staff/teacherAttendanceSettings.model.js.
// The standing late-rule grace period is 5 minutes (admin-changeable).
const DEFAULT_SETTINGS = {
  key: "default",
  lateDetectionEnabled: false,
  startTime: "08:00",
  graceMinutes: 5,
};

async function collectionExists(db, name) {
  const found = await db.listCollections({ name }).toArray();
  return found.length > 0;
}

async function ensureCollection(db, name) {
  if (await collectionExists(db, name)) {
    console.log(`  ⏭️  Collection "${name}" already exists — left untouched`);
    return;
  }
  await db.createCollection(name);
  console.log(`  ✅ Created collection "${name}"`);
}

async function ensureIndex(col, keys, options, label) {
  const existing = await col.indexes();
  const sameKeys = existing.find(
    (ix) => JSON.stringify(ix.key) === JSON.stringify(keys)
  );
  if (sameKeys) {
    console.log(`  ⏭️  Index ${label} already exists (${sameKeys.name})`);
    return;
  }
  await col.createIndex(keys, options);
  console.log(`  ✅ Created index ${label}`);
}

// ── UP ────────────────────────────────────────────────────────────────────────
async function up(db, isDryRun) {
  console.log("─── Collections ───────────────────────────────────────────────");
  for (const name of [ATTENDANCE_COL, SETTINGS_COL]) {
    const exists = await collectionExists(db, name);
    if (isDryRun) {
      console.log(`  ${exists ? "⏭️ " : "➕"} "${name}" — ${exists ? "already exists (no change)" : "would be created"}`);
    } else {
      await ensureCollection(db, name);
    }
  }

  console.log("\n─── Indexes ───────────────────────────────────────────────────");
  const attCol = db.collection(ATTENDANCE_COL);
  const setCol = db.collection(SETTINGS_COL);
  const indexPlan = [
    [attCol, { teacher: 1, date: 1 }, { unique: true, name: "teacher_1_date_1" }, "unique {teacher, date} on " + ATTENDANCE_COL],
    [attCol, { date: 1 }, { name: "date_1" }, "{date} on " + ATTENDANCE_COL],
    [setCol, { key: 1 }, { unique: true, name: "key_1" }, "unique {key} (singleton) on " + SETTINGS_COL],
  ];
  for (const [col, keys, opts, label] of indexPlan) {
    if (isDryRun) {
      console.log(`  ➕ ${label}`);
    } else {
      await ensureIndex(col, keys, opts, label);
    }
  }

  console.log("\n─── Default settings document ─────────────────────────────────");
  const existingSettings = await setCol.findOne({ key: "default" });
  if (!existingSettings) {
    if (isDryRun) {
      console.log(`  ➕ Would insert default rule: ${JSON.stringify(DEFAULT_SETTINGS)}`);
    } else {
      const now = new Date();
      await setCol.insertOne({ ...DEFAULT_SETTINGS, createdAt: now, updatedAt: now });
      console.log(`  ✅ Inserted default rule (late detection DISABLED): ${JSON.stringify(DEFAULT_SETTINGS)}`);
    }
  } else if (
    existingSettings.lateDetectionEnabled === false &&
    existingSettings.startTime === "08:00" &&
    existingSettings.graceMinutes === 0
  ) {
    // First rollout shipped the grace default as 0; the standing rule is now
    // 5 minutes. A doc still matching the old defaults byte-for-byte was
    // never touched by an admin, so upgrading ONLY graceMinutes is safe.
    // Any other value (including detection enabled) is left alone.
    if (isDryRun) {
      console.log("  ➕ Untouched legacy rule found — would upgrade graceMinutes 0 → 5");
    } else {
      await setCol.updateOne(
        { key: "default", lateDetectionEnabled: false, startTime: "08:00", graceMinutes: 0 },
        { $set: { graceMinutes: 5 } }
      );
      console.log("  ✅ Legacy default rule upgraded: graceMinutes 0 → 5 (everything else untouched)");
    }
  } else {
    console.log("  ⏭️  Settings document already exists — left untouched:");
    console.log(`     lateDetectionEnabled=${existingSettings.lateDetectionEnabled}, startTime=${existingSettings.startTime}, graceMinutes=${existingSettings.graceMinutes}`);
  }

  if (!isDryRun) {
    console.log("\n─── POST-MIGRATION VERIFICATION ───────────────────────────────");
    for (const name of [ATTENDANCE_COL, SETTINGS_COL]) {
      const col = db.collection(name);
      const count = await col.countDocuments({});
      const indexes = (await col.indexes()).map((ix) => ix.name).join(", ");
      console.log(`  "${name}": ${count} document(s), indexes [${indexes}]`);
    }
    console.log("\n✅ Migration complete. No existing collection was modified.\n");
  }
}

// ── DOWN (rollback) ───────────────────────────────────────────────────────────
async function down(db, isDryRun) {
  console.log("─── Rollback scope (ONLY these two NEW collections) ───────────");
  for (const name of [ATTENDANCE_COL, SETTINGS_COL]) {
    const exists = await collectionExists(db, name);
    const count = exists ? await db.collection(name).countDocuments({}) : 0;
    console.log(`  ${exists ? "🗑️ " : "⏭️ "} "${name}" — ${exists ? `${count} document(s) would be DROPPED` : "does not exist (no change)"}`);
  }
  console.log("\n  No other collection is touched by rollback.");

  if (isDryRun) return;

  console.log("\n─── EXECUTING ROLLBACK ────────────────────────────────────────");
  for (const name of [ATTENDANCE_COL, SETTINGS_COL]) {
    if (await collectionExists(db, name)) {
      await db.collection(name).drop();
      console.log(`  ✅ Dropped "${name}"`);
    }
  }
  console.log("\n✅ Rollback complete. Existing collections untouched.\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const isDryRun = !process.argv.includes("--confirm");
  const isRollback = process.argv.includes("--rollback");
  const dbUri = process.env.DB;

  if (!dbUri) {
    console.error("ERROR: process.env.DB is not set. Add it to your .env file.");
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   Teacher Attendance Migration — Phase 1 (additive)      ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nDirection: ${isRollback ? "ROLLBACK (drop new collections)" : "UP (create new collections)"}`);
  console.log(`Mode: ${isDryRun ? "🔍 DRY RUN (no changes will be made)" : "🔴 LIVE (will write changes to the database)"}\n`);

  if (!isDryRun) {
    console.log("⚠️  WARNING: You are about to WRITE changes to the database.");
    console.log("   Make sure you have taken a manual backup/export first.\n");
  }

  await mongoose.connect(dbUri);
  const dbName = mongoose.connection.name;
  console.log(`Connected to database: ${dbName}\n`);

  const db = mongoose.connection.db;
  if (isRollback) {
    await down(db, isDryRun);
  } else {
    await up(db, isDryRun);
  }

  if (isDryRun) {
    console.log("─── DRY RUN COMPLETE ──────────────────────────────────────────");
    console.log("  No changes were made to the database.");
    console.log(`  Review the report above, then re-run with --confirm${isRollback ? " --rollback" : ""} to apply.\n`);
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});