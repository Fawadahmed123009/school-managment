/**
 * Database maintenance script — TTL indexes for unbounded collections.
 *
 * Run once after deploy (and re-run after adding new log/activity features):
 *   node scripts/dbMaintenance.js
 *
 * Atlas M0 free tier is 512 MB.  Without TTL indexes, any collection that
 * grows over time (logs, notifications, activity feeds, temp OCR data) will
 * eventually exhaust storage.  This script creates TTL indexes so old docs
 * are automatically removed by MongoDB.
 *
 * Safe to run multiple times — createIndex is idempotent.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.DB;
if (!MONGO_URI) {
  console.error("ERROR: DB environment variable is not set.");
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB.");

  const db = mongoose.connection.db;

  // ── 1. TTL index on any "logs" collection ────────────────────
  // If your app ever writes to a "logs" collection, docs older than
  // 30 days are auto-deleted.
  try {
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map((c) => c.name);

    if (collectionNames.includes("logs")) {
      await db.collection("logs").createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 30 * 24 * 60 * 60, name: "ttl_logs_30d" }
      );
      console.log("✓ TTL index created on 'logs' collection (30 days)");
    } else {
      console.log("  'logs' collection does not exist yet — skipping.");
    }

    // ── 2. TTL index on any "notifications" collection ─────────
    if (collectionNames.includes("notifications")) {
      await db.collection("notifications").createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 90 * 24 * 60 * 60, name: "ttl_notifications_90d" }
      );
      console.log("✓ TTL index created on 'notifications' collection (90 days)");
    } else {
      console.log("  'notifications' collection does not exist yet — skipping.");
    }

    // ── 3. TTL index on any "activitylogs" / "auditlogs" collection ─
    for (const name of ["activitylogs", "auditlogs", "activity_logs", "audit_logs"]) {
      if (collectionNames.includes(name)) {
        await db.collection(name).createIndex(
          { createdAt: 1 },
          { expireAfterSeconds: 180 * 24 * 60 * 60, name: `ttl_${name}_180d` }
        );
        console.log(`✓ TTL index created on '${name}' collection (180 days)`);
      }
    }

    // ── 4. TTL index on any "tempocr" / "ocruploads" collection ─
    for (const name of ["tempocr", "ocruploads", "temp_ocr"]) {
      if (collectionNames.includes(name)) {
        await db.collection(name).createIndex(
          { createdAt: 1 },
          { expireAfterSeconds: 24 * 60 * 60, name: `ttl_${name}_1d` }
        );
        console.log(`✓ TTL index created on '${name}' collection (1 day)`);
      }
    }

    // ── 5. Print collection sizes for monitoring ───────────────
    console.log("\n── Collection sizes ──");
    const stats = await db.listCollections().toArray();
    for (const coll of stats) {
      try {
        const count = await db.collection(coll.name).estimatedDocumentCount();
        const collStats = await db.command({ collStats: coll.name });
        const sizeMB = ((collStats.size || 0) / (1024 * 1024)).toFixed(3);
        console.log(`  ${coll.name}: ${count} docs, ${sizeMB} MB`);
      } catch (_) { /* skip system collections */ }
    }

    console.log("\n✓ Database maintenance complete.");
  } catch (err) {
    console.error("Error during maintenance:", err.message);
  } finally {
    await mongoose.disconnect();
  }
}

main();
