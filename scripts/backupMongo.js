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

// ── Load .env BEFORE anything that reads process.env ───────────────
// R2 helpers used to be required above this line, so their module-level
// config check ran while every R2_* var was still undefined and the upload
// was silently skipped on every run (local-only backups).
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const { MongoClient } = require("mongodb");
const { uploadToR2, isR2Configured } = require("../utils/r2Client");

// ── S3 SDK — needed for verifying & deleting old remote backups ───
let ListObjectsV2Command, DeleteObjectsCommand, HeadObjectCommand;
try {
  ({ ListObjectsV2Command, DeleteObjectsCommand, HeadObjectCommand } = require("@aws-sdk/client-s3"));
} catch (_) {
  // @aws-sdk/client-s3 not installed — remote cleanup disabled
}

// ── Configuration ─────────────────────────────────────────────────
const MONGO_URI = process.env.DB;
const RETAIN_DAYS = parseInt(process.env.RETAIN_DAYS || "14", 10);
const R2_BACKUP_PREFIX = "backups/";
const PROJECT_DIR = path.resolve(__dirname, "..");
const BACKUPS_DIR = path.join(PROJECT_DIR, "backups");
const DRY_RUN = process.argv.includes("--dry-run");
// Off-box is the whole point of the R2 upload, so a run that fails to land a
// verified copy in the bucket exits non-zero (so cron/scheduler sees the
// failure) unless the operator explicitly opts back in to local-only.
const ALLOW_LOCAL_ONLY =
  process.argv.includes("--allow-local-only") ||
  ["1", "true"].includes(String(process.env.ALLOW_LOCAL_ONLY || "").toLowerCase());

// How many docs to hold in memory at once while streaming a
// collection to disk. Lower this further if the account's memory
// cap is very tight (e.g. 50-100).
const EXPORT_BATCH_SIZE = 500;

// ── Helpers ───────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// Dedicated heartbeat file, written synchronously (fs.appendFileSync)
// so entries hit disk immediately instead of sitting in Node's stdout
// buffer. If the process gets killed, this file still shows the last
// step that actually completed — unlike the cron-test.log, which can
// lose buffered console.log output on a hard kill.
const HEARTBEAT_FILE = path.join(PROJECT_DIR, "backup-heartbeat.log");
function heartbeat(msg) {
  const ts = new Date().toISOString();
  try {
    fs.appendFileSync(HEARTBEAT_FILE, `[${ts}] [pid ${process.pid}] ${msg}\n`);
  } catch (_) {
    // best-effort — never let heartbeat logging itself crash the backup
  }
}

function todayStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Streams a collection to a JSON file one batch at a time instead of
// pulling the whole collection into memory with .toArray() and then
// building one giant JSON.stringify() string. Memory use here is
// bounded by EXPORT_BATCH_SIZE, not by collection size.
async function exportCollectionStreaming(db, name, filePath) {
  const cursor = db.collection(name).find({}).batchSize(EXPORT_BATCH_SIZE);
  const writeStream = fs.createWriteStream(filePath, { encoding: "utf8" });

  let count = 0;
  let first = true;

  await new Promise((resolve, reject) => {
    writeStream.on("error", reject);
    writeStream.write("[\n");

    (async () => {
      try {
        while (await cursor.hasNext()) {
          const doc = await cursor.next();
          const chunk = (first ? "" : ",\n") + JSON.stringify(doc);
          first = false;
          count++;

          // Respect backpressure so we don't buffer faster than disk
          // can absorb it.
          if (!writeStream.write(chunk)) {
            await new Promise((r) => writeStream.once("drain", r));
          }
        }
        writeStream.end("\n]\n");
        writeStream.on("finish", () => resolve(count));
      } catch (err) {
        reject(err);
      }
    })();
  });

  return count;
}

// Counts documents without materializing them, for --dry-run.
async function countCollection(db, name) {
  return db.collection(name).countDocuments();
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  heartbeat("process started");
  log("═══════════════════════════════════════════════════════════");
  log("  MongoDB Backup — pure Node.js (no mongodump)");
  if (DRY_RUN) log("  ** DRY-RUN MODE — no files will be written **");
  log("═══════════════════════════════════════════════════════════");

  // ── Check R2 availability ─────────────────────────────────
  const cloudEnabled = isR2Configured();
  if (!cloudEnabled) {
    log("ERROR: R2 is not configured — a local-only archive is not a backup.");
    log("  Set the R2_* vars in .env, or pass --allow-local-only to accept that.");
    heartbeat("R2 not configured — aborting (local-only not accepted)");
    if (!DRY_RUN && !ALLOW_LOCAL_ONLY) process.exit(1);
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
  heartbeat("connecting to MongoDB");
  // Fail fast instead of hanging indefinitely on a network/firewall
  // issue (e.g. this server's IP not whitelisted in Atlas).
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
  });
  let collections;

  try {
    await client.connect();
    heartbeat("MongoDB connected");
    const db = client.db();
    collections = await db.listCollections().toArray();
    heartbeat(`listed ${collections.length} collections`);
    log(`✓ Connected. Database: "${db.databaseName}", ${collections.length} collection(s) found.`);
  } catch (err) {
    heartbeat(`MongoDB connect FAILED: ${err.message}`);
    log(`ERROR: Failed to connect to MongoDB: ${err.message}`);
    process.exit(1);
  }

  // ── Export each collection to JSON (streamed, not buffered) ──
  if (!DRY_RUN) fs.mkdirSync(datedDir, { recursive: true });
  log(`→ Exporting collections to ${datedDir}`);

  const db = client.db();
  let failed = 0;

  for (const col of collections) {
    const name = col.name;
    heartbeat(`exporting collection: ${name} — start`);
    try {
      if (DRY_RUN) {
        const count = await countCollection(db, name);
        log(`  ✓ ${name} — ${count} doc(s) (dry-run, not written)`);
      } else {
        const filePath = path.join(datedDir, `${name}.json`);
        const count = await exportCollectionStreaming(db, name, filePath);
        log(`  ✓ ${name} — ${count} doc(s)`);
      }
      heartbeat(`exporting collection: ${name} — done`);
    } catch (err) {
      failed++;
      heartbeat(`exporting collection: ${name} — FAILED: ${err.message}`);
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
    heartbeat("tar compression — start");
    try {
      // Run tar from the backups/ directory so paths inside the
      // archive are relative (just the date-tagged folder).
      execSync(
        `tar -czf "${tarball}" -C "${BACKUPS_DIR}" "${dateTag}"`,
        { stdio: "pipe" }
      );
      const sizeMB = (fs.statSync(tarball).size / (1024 * 1024)).toFixed(2);
      heartbeat(`tar compression — done (${sizeMB} MB)`);
      log(`✓ Compressed: ${dateTag}.tar.gz (${sizeMB} MB)`);
    } catch (err) {
      heartbeat(`tar compression — FAILED: ${err.message}`);
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

  // ── Upload tarball to Cloudflare R2 (streamed, not buffered) ──
  // remoteCopy is only set once the archive has been *confirmed present* in
  // the bucket (HeadObject), so "uploaded" never means "assumed uploaded".
  let remoteCopy = null;
  if (DRY_RUN) {
    if (cloudEnabled) {
      log(`→ [dry-run] Would upload to R2: ${R2_BACKUP_PREFIX}${path.basename(tarball)} — skipped.`);
    }
  } else if (cloudEnabled && fs.existsSync(tarball)) {
    const r2Key = `${R2_BACKUP_PREFIX}${path.basename(tarball)}`;
    log(`→ Uploading to R2: ${r2Key}`);
    heartbeat(`R2 upload — start (${r2Key})`);
    try {
      // Streamed upload with an explicit ContentLength (uploadToR2 accepts a
      // read stream + size), so a large archive never has to be buffered.
      const stats = fs.statSync(tarball);
      const fileStream = fs.createReadStream(tarball);
      await uploadToR2(r2Key, fileStream, "application/gzip", stats.size);
      heartbeat("R2 upload — done");
      log("✓ Upload complete.");

      // Confirm the object actually landed off-box, with matching size.
      const remoteBytes = await verifyRemoteBackup(r2Key);
      if (remoteBytes == null) {
        throw new Error(`bucket reports no object at ${r2Key}`);
      }
      if (remoteBytes !== stats.size) {
        throw new Error(`size mismatch — local ${stats.size} B, remote ${remoteBytes} B`);
      }
      remoteCopy = { key: r2Key, bytes: remoteBytes };
      heartbeat(`R2 verification — done (${remoteBytes} B present at ${r2Key})`);
      log(`✓ Verified off-box: ${r2Key} (${(remoteBytes / 1024).toFixed(1)} KB present in bucket).`);

      // Clean old remote backups from R2
      log(`→ Cleaning R2 backups older than ${RETAIN_DAYS} days...`);
      try {
        await cleanRemoteBackups();
        log("✓ Remote cleanup done.");
      } catch (err) {
        log(`WARNING: Remote cleanup failed: ${err.message}`);
      }
    } catch (err) {
      heartbeat(`R2 upload — FAILED: ${err.message}`);
      log(`ERROR: R2 upload/verification failed: ${err.message}`);
      log("  Local backup is still available (but this run is NOT off-box).");
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
  if (DRY_RUN) {
    log("  Remote:   (dry-run)");
  } else if (remoteCopy) {
    log(`  Remote:   r2://${process.env.R2_BUCKET_NAME}/${remoteCopy.key} — VERIFIED (${remoteCopy.bytes} B)`);
  } else {
    log("  Remote:   NOT VERIFIED OFF-BOX");
  }
  log(`  Collections: ${collections.length} (${collections.length - failed} exported OK)`);
  log("═══════════════════════════════════════════════════════════");

  // A backup that never landed off-box is a failed backup — say so loudly.
  if (!DRY_RUN && cloudEnabled && !remoteCopy && !ALLOW_LOCAL_ONLY) {
    log("✗ FAILED: no verified copy in R2 for this run.");
    heartbeat("process finished with FAILURE (no verified off-box copy)");
    process.exit(1);
  }

  log("✓ All done.");
  heartbeat("process finished successfully");
}

main().catch((err) => {
  log(`FATAL: ${err.message || err}`);
  process.exit(1);
});

// ── S3 client for remote-side checks (same credentials as r2Client) ─
function makeRemoteS3Client() {
  const { S3Client } = require("@aws-sdk/client-s3");
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Confirm an object really exists in the bucket and return its size in bytes.
 * @returns {Promise<number|null>} size, or null when the object is absent
 *                                 (or the bucket cannot be reached).
 */
async function verifyRemoteBackup(key) {
  const client = makeRemoteS3Client();
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })
    );
    return typeof head.ContentLength === "number" ? head.ContentLength : 0;
  } catch (err) {
    log(`  HeadObject(${key}) failed: ${err.name || ""} ${err.message || err}`);
    return null;
  }
}

// ── Clean old backups from R2 ────────────────────────────────────
async function cleanRemoteBackups() {
  const client = makeRemoteS3Client();

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