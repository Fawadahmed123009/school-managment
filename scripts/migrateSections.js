/**
 * Migration: Extract section from a hardcoded ClassLevel enum into an
 * independent Section entity.
 *
 * WHAT THIS SCRIPT DOES (dry-run mode — default):
 *   1. Reads every ClassLevel document from the database.
 *   2. Collects all distinct `section` string values (using the raw driver
 *      to catch values that Mongoose enum validation might reject).
 *   3. Normalizes messy values ("Boys ", "boys", "BOYS" → canonical "Boys").
 *   4. Reports which Section records it WOULD create.
 *   5. Shows how each existing ClassLevel maps to a Section.
 *   6. Flags any values it cannot confidently normalize for manual decision.
 *   7. Writes NOTHING to the database.
 *
 * USAGE:
 *   node scripts/migrateSections.js            # dry-run (preview only)
 *   node scripts/migrateSections.js --confirm   # ACTUAL WRITE (idempotent)
 *
 * SAFETY:
 *   - The existing `section` string field on ClassLevel is NEVER deleted or
 *     altered in this pass. A new `sectionRef` field is added alongside it.
 *   - The --confirm step is idempotent: re-running it will not create
 *     duplicate Section records.
 *   - TAKE A MANUAL DB BACKUP BEFORE RUNNING WITH --confirm.
 *
 * Environment:
 *   Uses process.env.DB for the MongoDB connection string.
 */

require("dotenv").config();
const mongoose = require("mongoose");

// ── Normalization rules ───────────────────────────────────────────────────────
// Maps lowercased+trimmed input → canonical Section name.
// Only "boys" and "girls" are recognized. Everything else that isn't blank/null
// is flagged as ambiguous for manual admin decision.
const KNOWN_SECTIONS = {
  boys: "Boys",
  girls: "Girls",
};

function normalizeSectionValue(raw) {
  if (raw === null || raw === undefined) return { canonical: null, confidence: "none" };
  const trimmed = String(raw).trim();
  if (trimmed === "") return { canonical: null, confidence: "none" };
  const lower = trimmed.toLowerCase();
  if (KNOWN_SECTIONS[lower]) {
    return { canonical: KNOWN_SECTIONS[lower], confidence: "high" };
  }
  // Cannot confidently normalize — flag for manual review
  return { canonical: null, confidence: "ambiguous", raw: trimmed };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const isDryRun = !process.argv.includes("--confirm");
  const dbUri = process.env.DB;

  if (!dbUri) {
    console.error("ERROR: process.env.DB is not set. Add it to your .env file.");
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   Section Migration — Extract section to own entity     ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nMode: ${isDryRun ? "🔍 DRY RUN (no changes will be made)" : "🔴 LIVE (will write changes to the database)"}\n`);

  if (!isDryRun) {
    console.log("⚠️  WARNING: You are about to WRITE changes to the database.");
    console.log("   Make sure you have taken a manual backup/export first.\n");
  }

  await mongoose.connect(dbUri);
  console.log("Connected to database.\n");

  const db = mongoose.connection.db;
  const classLevelsCol = db.collection("classlevels");
  const sectionsCol = db.collection("sections");

  // ── Step 1: Read all ClassLevel documents via raw driver ────────────────────
  const allClassLevels = await classLevelsCol.find({}).toArray();
  console.log(`Found ${allClassLevels.length} ClassLevel document(s).\n`);

  // ── Step 2: Collect distinct raw section values ─────────────────────────────
  const rawValueCounts = {};
  for (const cl of allClassLevels) {
    const key = cl.section === null || cl.section === undefined ? "<null>" : JSON.stringify(cl.section);
    rawValueCounts[key] = (rawValueCounts[key] || 0) + 1;
  }

  console.log("─── Distinct `section` values found in ClassLevel collection ───");
  for (const [val, count] of Object.entries(rawValueCounts).sort()) {
    console.log(`  ${val.padEnd(20)} → ${count} ClassLevel(s)`);
  }
  console.log();

  // ── Step 3: Normalize and classify ──────────────────────────────────────────
  const canonicalMap = {};   // canonical name → { rawValues: Set, classLevelIds: [] }
  const ambiguous = [];      // { raw, classLevels: [{ _id, name, gradeLevel }] }

  for (const cl of allClassLevels) {
    const result = normalizeSectionValue(cl.section);

    if (result.confidence === "none") {
      // null/empty → no section, nothing to migrate for this doc
      continue;
    }

    if (result.confidence === "high") {
      const canonical = result.canonical;
      if (!canonicalMap[canonical]) {
        canonicalMap[canonical] = { rawValues: new Set(), classLevelIds: [] };
      }
      canonicalMap[canonical].rawValues.add(cl.section === null ? "<null>" : String(cl.section));
      canonicalMap[canonical].classLevelIds.push(cl._id);
    }

    if (result.confidence === "ambiguous") {
      ambiguous.push({
        raw: result.raw,
        classLevelId: cl._id,
        classLevelName: cl.name,
        gradeLevel: cl.gradeLevel,
        group: cl.group || null,
      });
    }
  }

  // ── Step 4: Report what Section records would be created ────────────────────
  console.log("─── Section records to create ───────────────────────────────────");
  const canonicalNames = Object.keys(canonicalMap).sort();
  if (canonicalNames.length === 0) {
    console.log("  (none — no section values found)");
  } else {
    for (const name of canonicalNames) {
      const info = canonicalMap[name];
      console.log(`  ✅ "${name}"`);
      console.log(`     Normalized from raw value(s): ${[...info.rawValues].join(", ")}`);
      console.log(`     Would link ${info.classLevelIds.length} ClassLevel(s)`);
    }
  }
  console.log();

  // ── Step 5: Check for existing Section records (idempotency) ────────────────
  const existingSections = await sectionsCol.find({}).toArray();
  const existingByName = {};
  for (const s of existingSections) {
    existingByName[s.name] = s;
  }

  if (existingSections.length > 0) {
    console.log("─── Existing Section records already in database ────────────────");
    for (const s of existingSections) {
      console.log(`  • "${s.name}" (id: ${s._id}, active: ${s.isActive !== false})`);
    }
    console.log();
  }

  const toCreate = canonicalNames.filter((n) => !existingByName[n]);
  const alreadyExist = canonicalNames.filter((n) => !!existingByName[n]);

  if (alreadyExist.length > 0) {
    console.log("─── Section records already exist (will skip in --confirm) ──────");
    for (const name of alreadyExist) {
      console.log(`  ⏭️  "${name}" — already exists as ${existingByName[name]._id}`);
    }
    console.log();
  }

  if (toCreate.length > 0) {
    console.log("─── Section records to CREATE in --confirm mode ─────────────────");
    for (const name of toCreate) {
      console.log(`  ➕ "${name}"`);
    }
    console.log();
  } else if (canonicalNames.length > 0) {
    console.log("─── All Section records already exist. Nothing to create. ────────\n");
  }

  // ── Step 6: Ambiguous values report ─────────────────────────────────────────
  console.log("─── Ambiguous values (need manual admin decision) ───────────────");
  if (ambiguous.length === 0) {
    console.log("  (none — all non-null values were confidently normalized)");
  } else {
    // Group by raw value
    const byRaw = {};
    for (const a of ambiguous) {
      if (!byRaw[a.raw]) byRaw[a.raw] = [];
      byRaw[a.raw].push(a);
    }
    for (const [raw, items] of Object.entries(byRaw).sort()) {
      console.log(`\n  ❓ "${raw}" — ${items.length} ClassLevel(s):`);
      for (const item of items) {
        console.log(`     • ${item.classLevelName} (Grade ${item.gradeLevel}${item.group ? ", " + item.group : ""}) [${item.classLevelId}]`);
      }
    }
  }
  console.log();

  // ── Step 7: ClassLevel mapping detail ───────────────────────────────────────
  console.log("─── ClassLevel → Section mapping detail ─────────────────────────");
  let mappedCount = 0;
  let nullCount = 0;
  let ambiguousCount = ambiguous.length;

  for (const cl of allClassLevels) {
    const result = normalizeSectionValue(cl.section);
    if (result.confidence === "high") {
      mappedCount++;
      const sectionId = existingByName[result.canonical]?._id || `<new:${result.canonical}>`;
      console.log(`  ${cl.name} (Grade ${cl.gradeLevel}) → "${result.canonical}" [sectionRef: ${sectionId}]`);
    } else if (result.confidence === "none") {
      nullCount++;
      // Only show if it has a name (skip noise)
      console.log(`  ${cl.name} (Grade ${cl.gradeLevel}) → no section (sectionRef: null)`);
    } else {
      console.log(`  ${cl.name} (Grade ${cl.gradeLevel}) → ⚠️  AMBIGUOUS "${result.raw}" — needs manual decision`);
    }
  }
  console.log();

  // ── Step 8: Summary ─────────────────────────────────────────────────────────
  console.log("═══ SUMMARY ═══════════════════════════════════════════════════");
  console.log(`  Total ClassLevel docs:       ${allClassLevels.length}`);
  console.log(`  Would map to Section:        ${mappedCount}`);
  console.log(`  No section (null/empty):     ${nullCount}`);
  console.log(`  Ambiguous (manual review):   ${ambiguousCount}`);
  console.log(`  Section records to create:   ${toCreate.length}`);
  console.log(`  Section records exist:       ${alreadyExist.length}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── LIVE MODE: Execute writes ───────────────────────────────────────────────
  if (!isDryRun) {
    console.log("─── EXECUTING WRITES ────────────────────────────────────────────");

    // 1. Create missing Section records
    const sectionIdMap = {}; // canonical name → ObjectId
    for (const name of canonicalNames) {
      if (existingByName[name]) {
        sectionIdMap[name] = existingByName[name]._id;
      }
    }
    for (const name of toCreate) {
      const now = new Date();
      const result = await sectionsCol.insertOne({
        name,
        isActive: true,
        createdBy: null, // will be set by admin UI going forward; migration has no single admin
        createdAt: now,
        updatedAt: now,
      });
      sectionIdMap[name] = result.insertedId;
      console.log(`  ✅ Created Section "${name}" → ${result.insertedId}`);
    }

    // 2. Set sectionRef on each ClassLevel that has a confidently-mapped section
    let updatedCount = 0;
    for (const cl of allClassLevels) {
      const result = normalizeSectionValue(cl.section);
      if (result.confidence === "high" && sectionIdMap[result.canonical]) {
        const updateResult = await classLevelsCol.updateOne(
          { _id: cl._id },
          { $set: { sectionRef: sectionIdMap[result.canonical] } }
        );
        if (updateResult.modifiedCount > 0 || (updateResult.matchedCount > 0 && cl.sectionRef && cl.sectionRef.equals(sectionIdMap[result.canonical]))) {
          updatedCount++;
        }
      }
    }
    console.log(`  ✅ Set sectionRef on ${updatedCount} ClassLevel document(s)`);

    // 3. Ensure index on Section.name for uniqueness
    try {
      await sectionsCol.createIndex({ name: 1 }, { unique: true });
      console.log("  ✅ Created unique index on Section.name");
    } catch (e) {
      if (e.code === 85) {
        console.log("  ⏭️  Unique index on Section.name already exists");
      } else {
        console.log(`  ⚠️  Index creation: ${e.message}`);
      }
    }

    console.log("\n─── POST-MIGRATION VERIFICATION ────────────────────────────────");
    const verifySections = await sectionsCol.find({}).toArray();
    console.log(`  Section records in DB: ${verifySections.length}`);
    for (const s of verifySections) {
      const linkedClasses = await classLevelsCol.countDocuments({ sectionRef: s._id });
      console.log(`    • "${s.name}" → linked to ${linkedClasses} ClassLevel(s)`);
    }

    const classesWithoutRef = await classLevelsCol.countDocuments({
      section: { $nin: [null, ""] },
      sectionRef: null,
    });
    if (classesWithoutRef > 0) {
      console.log(`\n  ⚠️  ${classesWithoutRef} ClassLevel(s) have a section string but NO sectionRef.`);
      console.log("     These are the ambiguous values flagged above — resolve manually.");
    }

    console.log("\n✅ Migration complete. Old `section` string field preserved as fallback.\n");
  } else {
    console.log("─── DRY RUN COMPLETE ────────────────────────────────────────────");
    console.log("  No changes were made to the database.");
    console.log("  Review the report above, then re-run with --confirm to apply.\n");
    console.log("  ⚠️  REMEMBER: Take a manual DB backup before running --confirm:");
    console.log("     mongodump --uri=\"<your-DB-uri>\" --out=backup_$(date +%Y%m%d)");
    console.log();
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
