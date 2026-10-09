/**
 * One-off data script: set Subject.displayName for program-split subjects.
 *
 * WHAT THIS SCRIPT DOES (dry-run mode — default):
 *   1. Reads every Subject document.
 *   2. Matches names ending in a program suffix (" Middle", " Matric", " Inter")
 *      e.g. "English Middle" / "English Matric" / "English Inter" → "English".
 *   3. Reports which documents it WOULD set displayName on (base label).
 *   4. Subjects without a recognized suffix (e.g. "Punjabi", "Home Economics")
 *      are left untouched — display call sites fall back to `name`.
 *
 * USAGE:
 *   node scripts/setSubjectDisplayNames.js            # dry-run (preview only)
 *   node scripts/setSubjectDisplayNames.js --confirm   # ACTUAL WRITE (idempotent)
 *
 * SAFETY:
 *   - ONLY the optional `displayName` field is written. `name` (the internal
 *     grouping/uniqueness key) is NEVER altered, so all reports, aggregations
 *     and dashboards keep Middle/Matric/Inter separate exactly as before.
 *   - Idempotent: re-running updates nothing that already carries the label.
 *
 * Environment:
 *   Uses process.env.DB for the MongoDB connection string.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const PROGRAM_SUFFIX_RE = /^(.+?)\s+(Middle|Matric|Inter)$/;

(async () => {
  const confirm = process.argv.includes("--confirm");
  if (!process.env.DB) {
    console.error("Missing process.env.DB connection string.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DB);
  // Register the Program model first — subject.model populates it and mongoose
  // throws if the ref'd model is not registered yet.
  require("../models/Academic/program.model");
  const Subject = require("../models/Academic/subject.model");

  const subjects = await Subject.find().populate("program", "name").lean();
  const plan = [];
  subjects.forEach((s) => {
    const m = (s.name || "").trim().match(PROGRAM_SUFFIX_RE);
    if (!m) {
      console.log(`SKIP   "${s.name}" (${(s.program && s.program.name) || "no program"}) — no program suffix, falls back to name`);
      return;
    }
    const base = m[1].trim();
    if (!base) {
      console.log(`SKIP   "${s.name}" — empty base label`);
      return;
    }
    if (s.displayName === base) {
      console.log(`OK     "${s.name}" already displayName="${base}"`);
      return;
    }
    plan.push({ _id: s._id, name: s.name, base, program: (s.program && s.program.name) || "?" });
  });

  console.log(`\n${confirm ? "APPLYING" : "WOULD APPLY"} ${plan.length} update(s):`);
  plan.forEach((p) => console.log(`  SET  "${p.name}" (${p.program}) → displayName="${p.base}"`));

  if (plan.length === 0) {
    console.log("Nothing to do.");
  } else if (!confirm) {
    console.log("\nDry run — no writes. Re-run with --confirm to apply.");
  } else {
    for (const p of plan) {
      await Subject.updateOne({ _id: p._id }, { $set: { displayName: p.base } });
    }
    console.log(`\nApplied ${plan.length} displayName update(s). name field untouched.`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
