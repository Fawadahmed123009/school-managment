#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────
// MongoDB backup script — pure Node.js, no mongodump required.
//
// Connects via the native `mongodb` driver, exports every collection
// to JSON files, compresses them with tar+gzip, optionally uploads
// to Google Drive via rclone, and cleans up old local backups.
//
// Usage:
//   node scripts/backupMongo.js [--dry-run]
//
// Options:
//   --dry-run     Read-only check: connects to MongoDB, lists collections
//                 and doc counts, but writes nothing to disk.
//
// Environment (read from .env or exported beforehand):
//   DB            — MongoDB connection string (required)
//   RCLONE_REMOTE — rclone destination, e.g. "gdrive:AvensLMS-Backups"
//                   (leave empty / unset to skip cloud sync)
//   RETAIN_DAYS   — local retention in days (default: 14)
// ──────────────────────────────────────────────────────────────────

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const { MongoClient } = require("mongodb");

// ── Load .env relative to this script so it works from any cwd ────
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

// ── Configuration ─────────────────────────────────────────────────
const MONGO_URI = process.env.DB;
const RCLONE_REMOTE = process.env.RCLONE_REMOTE || "";
const RETAIN_DAYS = parseInt(process.env.RETAIN_DAYS || "14", 10);
const PROJECT_DIR = path.resolve(__dirname, "..");
const BACKUPS_DIR = path.join(PROJECT_DIR, "backups");
const DRY_RUN = process.argv.includes("--dry-run");

// ── Helpers ───────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  log("═══════════════════════════════════════════════════════════");
  log("  MongoDB Backup — pure Node.js (no mongodump)");
  if (DRY_RUN) log("  ** DRY-RUN MODE — no files will be written **");
  log("═══════════════════════════════════════════════════════════");

  // ── Check rclone availability ─────────────────────────────
  let cloudEnabled = !!RCLONE_REMOTE;
  if (RCLONE_REMOTE) {
    try {
      execSync("which rclone", { stdio: "pipe" });
    } catch (_) {
      log("WARNING: rclone not found — skipping cloud upload, local backup only");
      cloudEnabled = false;
    }
  }

  // ── Validate connection string ───────────────────────────────
  if (!MONGO_URI) {
    log("ERROR: DB environment variable is not set.");
    log("  Set it in .env or export it before running this script.");
    process.exit(1);
  }

  const dateTag = todayStr();
  const datedDir = path.join(BACKUPS_DIR, dateTag);
  const tarball = `${datedDir}.tar.gz`;

  // ── Connect to MongoDB ───────────────────────────────────────
  log("→ Connecting to MongoDB...");
  const client = new MongoClient(MONGO_URI);
  let collections;

  try {
    await client.connect();
    const db = client.db();
    collections = await db.listCollections().toArray();
    log(`✓ Connected. Database: "${db.databaseName}", ${collections.length} collection(s) found.`);
  } catch (err) {
    log(`ERROR: Failed to connect to MongoDB: ${err.message}`);
    process.exit(1);
  }

  // ── Export each collection to JSON ───────────────────────────
  if (!DRY_RUN) fs.mkdirSync(datedDir, { recursive: true });
  log(`→ Exporting collections to ${datedDir}`);

  const db = client.db();
  let failed = 0;

  for (const col of collections) {
    const name = col.name;
    try {
      const docs = await db.collection(name).find({}).toArray();
      if (DRY_RUN) {
        log(`  ✓ ${name} — ${docs.length} doc(s) (dry-run, not written)`);
      } else {
        const filePath = path.join(datedDir, `${name}.json`);
        fs.writeFileSync(filePath, JSON.stringify(docs, null, 2));
        log(`  ✓ ${name} — ${docs.length} doc(s)`);
      }
    } catch (err) {
      failed++;
      log(`  ✗ ${name} — FAILED: ${err.message} (continuing)`);
    }
  }

  log(`→ Export complete: ${collections.length - failed}/${collections.length} succeeded` +
      (failed ? `, ${failed} failed` : ""));

  // ── Close database connection ────────────────────────────────
  await client.close();
  log("✓ MongoDB connection closed.");

  // ── Compress the dated folder ────────────────────────────────
  if (DRY_RUN) {
    log("→ [dry-run] Would compress and create tarball — skipped.");
  } else {
    log(`→ Compressing ${dateTag}/ into ${dateTag}.tar.gz ...`);
    try {
      // Run tar from the backups/ directory so paths inside the
      // archive are relative (just the date-tagged folder).
      execSync(
        `tar -czf "${tarball}" -C "${BACKUPS_DIR}" "${dateTag}"`,
        { stdio: "pipe" }
      );
      const sizeMB = (fs.statSync(tarball).size / (1024 * 1024)).toFixed(2);
      log(`✓ Compressed: ${dateTag}.tar.gz (${sizeMB} MB)`);
    } catch (err) {
      log(`ERROR: Compression failed: ${err.message}`);
      log("  The uncompressed folder is kept for manual recovery.");
      // Don't exit — try to continue with upload / cleanup
    }

    // ── Remove uncompressed folder ───────────────────────────────
    if (fs.existsSync(tarball)) {
      try {
        fs.rmSync(datedDir, { recursive: true, force: true });
        log(`✓ Removed uncompressed folder: ${dateTag}/`);
      } catch (err) {
        log(`WARNING: Could not remove uncompressed folder: ${err.message}`);
      }
    }
  }

  // ── Upload to Google Drive via rclone ────────────────────────
  if (DRY_RUN) {
    if (cloudEnabled) {
      log(`→ [dry-run] Would upload to rclone remote: ${RCLONE_REMOTE} — skipped.`);
    }
  } else if (cloudEnabled && fs.existsSync(tarball)) {
    log(`→ Uploading to rclone remote: ${RCLONE_REMOTE}`);
    try {
      execSync(
        `rclone copy "${tarball}" "${RCLONE_REMOTE}" --verbose=1`,
        { stdio: "pipe", timeout: 300_000 }
      );
      log("✓ Upload complete.");

      // Clean old remote backups
      log(`→ Cleaning remote backups older than ${RETAIN_DAYS} days...`);
      try {
        execSync(
          `rclone delete "${RCLONE_REMOTE}" --min-age "${RETAIN_DAYS}d" --verbose=1`,
          { stdio: "pipe", timeout: 120_000 }
        );
        log("✓ Remote cleanup done.");
      } catch (err) {
        log(`WARNING: Remote cleanup failed: ${err.message}`);
      }
    } catch (err) {
      log(`WARNING: rclone upload failed: ${err.message}`);
      log("  Local backup is still available.");
    }
  } else if (!cloudEnabled && !RCLONE_REMOTE) {
    log("  NOTE: RCLONE_REMOTE not set. Skipping cloud sync.");
  }

  // ── Clean up old local backups ───────────────────────────────
  if (DRY_RUN) {
    log("→ [dry-run] Would clean up old local backups — skipped.");
  } else {
    log(`→ Cleaning up local backups older than ${RETAIN_DAYS} days...`);
    let deletedCount = 0;
    try {
      const entries = fs.readdirSync(BACKUPS_DIR);
      const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;

      for (const entry of entries) {
        // Only target .tar.gz files matching our naming pattern
        if (!/^\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(entry)) continue;
        const fullPath = path.join(BACKUPS_DIR, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          log(`  Removed: ${entry}`);
          deletedCount++;
        }
      }

      // Also clean any orphaned uncompressed folders
      for (const entry of entries) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
        const fullPath = path.join(BACKUPS_DIR, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          log(`  Removed folder: ${entry}/`);
          deletedCount++;
        }
      }
    } catch (err) {
      log(`WARNING: Cleanup error: ${err.message}`);
    }
    log(`✓ Removed ${deletedCount} old backup(s).`);
  }

  // ── Summary ──────────────────────────────────────────────────
  let totalFiles = 0;
  let totalSize = "0 B";
  try {
    const remaining = fs.readdirSync(BACKUPS_DIR).filter((e) =>
      /^\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(e)
    );
    totalFiles = remaining.length;
    // Calculate total size
    let bytes = 0;
    for (const f of remaining) {
      bytes += fs.statSync(path.join(BACKUPS_DIR, f)).size;
    }
    if (bytes > 1024 * 1024) totalSize = `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    else if (bytes > 1024) totalSize = `${(bytes / 1024).toFixed(1)} KB`;
    else totalSize = `${bytes} B`;
  } catch (_) {
    // backups dir might not exist yet on first run with errors
  }

  log("");
  log("═══════════════════════════════════════════════════════════");
  log("  Backup summary");
  log(`  Archive:  ${dateTag}.tar.gz`);
  log(`  Retain:   ${RETAIN_DAYS} days`);
  log(`  Local:    ${totalFiles} backup(s) (${totalSize})`);
  log(`  Collections: ${collections.length} (${collections.length - failed} exported OK)`);
  log("═══════════════════════════════════════════════════════════");
  log("✓ All done.");
}

main().catch((err) => {
  log(`FATAL: ${err.message || err}`);
  process.exit(1);
});
