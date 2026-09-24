#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────
// MongoDB restore script — companion to scripts/backupMongo.js.
//
// Re-imports a JSON backup (an extracted folder OR a .tar.gz produced
// by backupMongo.js) back into a MongoDB database using the native
// driver, so a snapshot is a real rollback point and not just a pile
// of files.
//
// The backup format stores ObjectIds as plain 24-char hex strings and
// dates as ISO-8601 strings. This script reconstructs both types on
// import (see reviveTypes) so restored docs keep correct field types.
//
// SAFETY MODEL (deliberately non-casual about touching live data):
//   • Requires an explicit --into <dbname> for every restore.
//   • Refuses to run against the live DB (the database name in the DB
//     env var) unless BOTH --into matches that name AND --yes is given.
//   • --dry-run reads and type-revives every doc but writes nothing.
//   • A restore REPLACES each collection (deleteMany then insertMany);
//     collections present in the live DB but absent from the backup are
//     left untouched and reported.
//
// Usage:
//   node scripts/restoreMongo.js <backup.tar.gz|backupDir> --into <dbname> [--dry-run] [--yes]
//
// Examples:
//   # Validate a snapshot into a scratch DB (recommended before any live rollback):
//   node scripts/restoreMongo.js backups/2026-09-24.tar.gz --into school-mgmt-verify
//   # Preview only, nothing written:
//   node scripts/restoreMongo.js backups/2026-09-24.tar.gz --into school-mgmt-verify --dry-run
//   # Actual rollback into the live database (destructive):
//   node scripts/restoreMongo.js backups/2026-09-24.tar.gz --into school-mgmt --yes
// ──────────────────────────────────────────────────────────────────

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const { MongoClient, ObjectId } = require("mongodb");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const MONGO_URI = process.env.DB;

// ── Type revival ──────────────────────────────────────────────────
// A 24-char lowercase-hex string that is not an ISO date is an ObjectId.
const HEX24 = /^[0-9a-f]{24}$/;
// ISO-8601 timestamps written by JSON.stringify(Date): 2026-09-20T08:47:26.335Z
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function reviveValue(value) {
  if (typeof value === "string") {
    if (ISO_DATE.test(value)) {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) return new Date(value);
    }
    if (HEX24.test(value)) {
      // ObjectId() accepts a 24-hex string; safe because ISO dates are
      // longer than 24 chars and were already handled above.
      return new ObjectId(value);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(reviveValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = reviveValue(v);
    return out;
  }
  return value;
}

// ── Arg parsing ───────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [], into: null, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--into") args.into = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--yes") args.yes = true;
    else args._.push(a);
  }
  return args;
}

function usageExit(msg) {
  if (msg) console.error(`ERROR: ${msg}`);
  console.error(
    "Usage: node scripts/restoreMongo.js <backup.tar.gz|backupDir> --into <dbname> [--dry-run] [--yes]"
  );
  process.exit(1);
}

// Resolve the backup source to a directory of <collection>.json files.
// Tarballs are extracted to a temp dir that we clean up afterwards.
function resolveSourceDir(source) {
  const abs = path.resolve(source);
  if (!fs.existsSync(abs)) usageExit(`backup source not found: ${source}`);
  if (fs.statSync(abs).isDirectory()) return { dir: abs, temp: null };
  if (abs.endsWith(".tar.gz")) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
    execSync(`tar -xzf "${abs}" -C "${temp}"`, { stdio: "pipe" });
    // tarballs contain a single date-tagged folder; descend if so.
    const entries = fs.readdirSync(temp);
    if (entries.length === 1 && fs.statSync(path.join(temp, entries[0])).isDirectory()) {
      return { dir: path.join(temp, entries[0]), temp };
    }
    return { dir: temp, temp };
  }
  usageExit(`backup source must be a directory or a .tar.gz file: ${source}`);
}

function liveDbName() {
  // Best-effort: read the database name from the connection string path.
  try {
    const u = new URL(MONGO_URI.replace(/^mongodb/, "http"));
    const name = u.pathname.replace(/^\//, "");
    return name || null;
  } catch (_) {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length !== 1) usageExit("exactly one backup source is required");
  if (!args.into) usageExit("--into <dbname> is required (explicit target)");
  if (!MONGO_URI) usageExit("DB environment variable is not set");

  const { dir, temp } = resolveSourceDir(args._[0]);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ collection: f.replace(/\.json$/, ""), file: path.join(dir, f) }));

  if (files.length === 0) usageExit(`no .json collection files found in ${dir}`);

  const liveName = liveDbName();
  const targetingLive = liveName && args.into === liveName;
  if (targetingLive && !args.dryRun && !args.yes) {
    usageExit(
      `refusing to overwrite live database "${liveName}" without --yes (use a scratch --into or add --dry-run)`
    );
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MongoDB Restore — from backup snapshot");
  console.log(`  Source:   ${path.resolve(args._[0])}`);
  console.log(`  Target:   "${args.into}"${targetingLive ? "  (⚠ LIVE DB)" : ""}`);
  console.log(`  Mode:     ${args.dryRun ? "DRY-RUN (nothing written)" : "RESTORE"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
  });

  try {
    await client.connect();
    const db = client.db(args.into);
    console.log(`✓ Connected. Resolved database name: "${db.databaseName}"`);

    let totalDocs = 0;
    const restored = [];
    for (const { collection, file } of files) {
      const raw = fs.readFileSync(file, "utf8");
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) {
        console.log(`  ✗ ${collection} — file is not a JSON array, skipping`);
        continue;
      }
      const docs = arr.map(reviveValue);
      totalDocs += docs.length;

      if (args.dryRun) {
        console.log(`  ✓ ${collection} — ${docs.length} doc(s) (dry-run, not written)`);
        restored.push(collection);
        continue;
      }

      const col = db.collection(collection);
      await col.deleteMany({});
      if (docs.length > 0) {
        await col.insertMany(docs, { ordered: false });
      }
      const after = await col.countDocuments();
      const flag = after === docs.length ? "✓" : "!";
      console.log(
        `  ${flag} ${collection} — wrote ${docs.length}, present ${after}` +
          (after === docs.length ? "" : "  (COUNT MISMATCH)")
      );
      restored.push(collection);
    }

    if (!args.dryRun) {
      // Report live collections not present in the backup (left untouched).
      const liveCols = (await db.listCollections().toArray()).map((c) => c.name);
      const skipped = liveCols.filter((c) => !restored.includes(c));
      if (skipped.length) {
        console.log(`\n  Not in backup (left untouched): ${skipped.join(", ")}`);
      }
    }

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log(`  ${args.dryRun ? "Dry-run" : "Restore"} summary`);
    console.log(`  Collections: ${restored.length}`);
    console.log(`  Documents:   ${totalDocs}`);
    console.log("═══════════════════════════════════════════════════════════");
    console.log(args.dryRun ? "✓ Dry-run complete (no writes)." : "✓ Restore complete.");
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
    if (temp) {
      try {
        fs.rmSync(temp, { recursive: true, force: true });
      } catch (_) {
        /* best-effort temp cleanup */
      }
    }
  }
}

main();
