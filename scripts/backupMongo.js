#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────
// MongoDB backup script — pure Node.js, no mongodump required.
//
// Connects via the native `mongodb` driver, exports every collection
// to JSON files, compresses them with tar+gzip, uploads the tarball
// to Cloudflare R2 (backups/ prefix), and cleans up old backups.
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
//   R2_*          — Cloudflare R2 credentials (same as photo uploads)
//                   Upload is skipped if R2 is not configured.
//   RETAIN_DAYS   — local + remote retention in days (default: 14)
// ──────────────────────────────────────────────────────────────────

const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const { MongoClient } = require("mongodb");
const { uploadToR2, isR2Configured } = require("../utils/r2Client");

// ── S3 SDK — needed for listing & deleting old remote backups ────
let ListObjectsV2Command, DeleteObjectsCommand;
try {
  ({ ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3"));
} catch (_) {
  // @aws-sdk/client-s3 not installed — remote cleanup disabled
}

// ── Load .env relative to this script so it works from any cwd ────
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

// ── Configuration ─────────────────────────────────────────────────
const MONGO_URI = process.env.DB;
const RETAIN_DAYS = parseInt(process.env.RETAIN_DAYS || "14", 10);
const R2_BACKUP_PREFIX = "backups/";
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

  // ── Check R2 availability ─────────────────────────────────
  const cloudEnabled = isR2Configured();
  if (!cloudEnabled) {
    log("NOTE: R2 not configured — skipping cloud upload, local backup only.");
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

  // ── Upload tarball to Cloudflare R2 ──────────────────────────
  if (DRY_RUN) {
    if (cloudEnabled) {
      log(`→ [dry-run] Would upload to R2: ${R2_BACKUP_PREFIX}${path.basename(tarball)} — skipped.`);
    }
  } else if (cloudEnabled && fs.existsSync(tarball)) {
    const r2Key = `${R2_BACKUP_PREFIX}${path.basename(tarball)}`;
    log(`→ Uploading to R2: ${r2Key}`);
    try {
      const fileBuffer = fs.readFileSync(tarball);
      await uploadToR2(r2Key, fileBuffer, "application/gzip");
      log("✓ Upload complete.");

      // Clean old remote backups from R2
      log(`→ Cleaning R2 backups older than ${RETAIN_DAYS} days...`);
      try {
        await cleanRemoteBackups();
        log("✓ Remote cleanup done.");
      } catch (err) {
        log(`WARNING: Remote cleanup failed: ${err.message}`);
      }
    } catch (err) {
      log(`WARNING: R2 upload failed: ${err.message}`);
      log("  Local backup is still available.");
    }
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

// ── Clean old backups from R2 ────────────────────────────────────
async function cleanRemoteBackups() {
  // Dynamically require the S3Client from r2Client's dependency
  const { S3Client } = require("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const bucket = process.env.R2_BUCKET_NAME;

  // List all objects under the backups/ prefix
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: R2_BACKUP_PREFIX })
  );

  const objects = (listed.Contents || []).filter(
    (o) => o.Key.endsWith(".tar.gz") && o.LastModified && o.LastModified.getTime() < cutoff
  );

  if (objects.length === 0) {
    log("  No old remote backups to clean.");
    return;
  }

  // Delete in batches of 1000 (S3 API limit)
  for (let i = 0; i < objects.length; i += 1000) {
    const batch = objects.slice(i, i + 1000).map((o) => ({ Key: o.Key }));
    await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch } })
    );
    for (const o of batch) {
      log(`  Removed remote: ${o.Key}`);
    }
  }
}
