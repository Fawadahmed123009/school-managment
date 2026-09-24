/**
 * Duplicate-email report (read-only).
 *
 * Scans Admin / Teacher / Parent / Student accounts, groups them by
 * case-insensitive, trimmed email, and for every email shared by 2+ accounts
 * reports: collection, ids, names, exact stored email, creation dates, status
 * flags, and associated data (fees, results, attendance, children, assignments).
 *
 * No login-history collection exists in this app and login services do not log
 * successful sign-ins, so "login history" is reported from account status
 * fields + this limitation. This script NEVER mutates data.
 *
 * Usage: node scripts/duplicateEmailReport.js [outputFile.md]
 */
require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");

// Model definitions (for collection names / discriminator-free raw queries).
require("../models/Staff/admin.model");
require("../models/Staff/teachers.model");
require("../models/Parents/parents.model");
require("../models/Students/students.model");
require("../models/Fees/fees.model");
require("../models/Fees/feeAudit.model");
require("../models/Academic/attendance.model");
require("../models/Academic/testResult.model");
require("../models/Academic/results.model");
require("../models/Academic/assignment.model");
require("../models/Academic/exams.model");
require("../models/Academic/class.model");

const MODELS = ["Admin", "Teacher", "Parent", "Student", "Fees", "FeeAudit",
  "Attendance", "TestResult", "ExamResult", "Assignment", "Exam", "ClassLevel"];

const L = [];
const out = (line = "") => L.push(line);

async function main() {
  await mongoose.connect(process.env.DB);
  const db = mongoose.connection.db;
  const col = (name) => db.collection(mongoose.model(name).collection.name);

  // ── 1. Collect all accounts ──────────────────────────────────────────
  const accountCols = ["Admin", "Teacher", "Parent", "Student"];
  const accounts = [];
  for (const model of accountCols) {
    const docs = await col(model)
      .find({}, { projection: { name: 1, email: 1, role: 1, createdAt: 1, updatedAt: 1, isWithdrawn: 1, isSuspended: 1, applicationStatus: 1, classLevel: 1, parent: 1, status: 1 } })
      .toArray();
    for (const d of docs) accounts.push({ model, doc: d });
  }

  // ── 2. Group by normalized email ─────────────────────────────────────
  const groups = new Map(); // normKey -> [{model, doc}]
  for (const a of accounts) {
    const raw = typeof a.doc.email === "string" ? a.doc.email : "";
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const dupKeys = [...groups.entries()]
    .filter(([, arr]) => arr.length >= 2)
    .sort((x, y) => x[0].localeCompare(y[0]));

  // ── 3. Enrichment helpers (raw collection counts, bypass app hooks) ──
  const idOf = (a) => a.doc._id;
  const fmtDate = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "—");

  async function studentSummary(a) {
    const id = idOf(a);
    const feesRaw = await col("Fees").countDocuments({ student: id });
    const feesActive = await col("Fees").countDocuments({ student: id, isDeleted: { $ne: true } });
    const paid = await col("Fees").aggregate([
      { $match: { student: id, isDeleted: { $ne: true } } },
      { $group: { _id: null, paid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } }, due: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$amount", 0] } } } },
    ]).toArray();
    const testResults = await col("TestResult").countDocuments({ student: id });
    const examResults = await col("ExamResult").countDocuments({ student: id });
    const attendance = await col("Attendance").countDocuments({ student: id });
    const cls = a.doc.classLevel
      ? await col("ClassLevel").findOne({ _id: a.doc.classLevel }, { projection: { section: 1, yearGroup: 1 } })
      : null;
    const parent = a.doc.parent
      ? await col("Parent").findOne({ _id: a.doc.parent }, { projection: { name: 1, email: 1 } })
      : null;
    return {
      feesRaw, feesActive,
      paidCount: paid[0]?.paid || 0, pendingDue: paid[0]?.due || 0,
      testResults, examResults, attendance,
      extra: `status=${a.doc.status || "n/a"} · class section: ${cls ? cls.section : "none"} · parent: ${parent ? `${parent.name} <${parent.email}>` : (a.doc.parent ? "dangling ref" : "none")}`,
    };
  }

  async function parentSummary(a) {
    const id = idOf(a);
    const children = await col("Student").find({ parent: id }, { projection: { name: 1, email: 1 } }).toArray();
    const childIds = children.map((c) => c._id);
    let feesActive = 0, testResults = 0, attendance = 0;
    if (childIds.length) {
      feesActive = await col("Fees").countDocuments({ student: { $in: childIds }, isDeleted: { $ne: true } });
      testResults = await col("TestResult").countDocuments({ student: { $in: childIds } });
      attendance = await col("Attendance").countDocuments({ student: { $in: childIds } });
    }
    return {
      feesRaw: feesActive, feesActive, paidCount: 0, pendingDue: 0,
      testResults, examResults: 0, attendance,
      extra: `children: ${children.length ? children.map((c) => `${c.name} <${c.email}>`).join("; ") : "none"}`,
    };
  }

  async function teacherSummary(a) {
    const id = idOf(a);
    const assignments = await col("Assignment").countDocuments({ teacher: id });
    const examsCreated = await col("Exam").countDocuments({ createdBy: id });
    const attendanceTaken = await col("Attendance").countDocuments({ markedBy: id });
    const classesIn = await col("ClassLevel").countDocuments({ teachers: id });
    return {
      feesRaw: 0, feesActive: 0, paidCount: 0, pendingDue: 0,
      testResults: 0, examResults: 0, attendance: attendanceTaken,
      extra: `assignments: ${assignments} · exams created: ${examsCreated} · attendance sheets taken: ${attendanceTaken} · classes: ${classesIn} · flags: withdrawn=${!!a.doc.isWithdrawn} suspended=${!!a.doc.isSuspended} status=${a.doc.applicationStatus || "n/a"}`,
    };
  }

  async function adminSummary(a) {
    const id = idOf(a);
    const feesRecorded = await col("Fees").countDocuments({ recordedBy: id });
    const auditEntries = await col("FeeAudit").countDocuments({ actor: id });
    return {
      feesRaw: feesRecorded, feesActive: 0, paidCount: 0, pendingDue: 0,
      testResults: 0, examResults: 0, attendance: 0,
      extra: `fees recorded by: ${feesRecorded} · fee-audit entries by: ${auditEntries}`,
    };
  }

  const summarizers = {
    Student: studentSummary, Parent: parentSummary,
    Teacher: teacherSummary, Admin: adminSummary,
  };

  // ── 4. Write report ──────────────────────────────────────────────────
  out("# Duplicate Email Accounts Report");
  out(`Generated: ${new Date().toISOString()} · DB: ${mongoose.connection.name} · READ-ONLY (no changes made)`);
  out("");
  const counts = accounts.reduce((acc, a) => ((acc[a.model] = (acc[a.model] || 0) + 1), acc), {});
  out(`Accounts scanned: ${accountCols.map((m) => `${m}=${counts[m] || 0}`).join(" · ")} (total ${accounts.length})`);
  out("");
  out(`Email keys shared by 2+ accounts: **${dupKeys.length}**`);
  out("");
  out("> **Login history:** this app stores no login history (no lastLogin field, no login events in logs).");
  out("> Note: login lookups use an exact-match `findOne({ email })`, so accounts whose emails differ only");
  out("> in case are ambiguous — the statically first matching document in natural order wins the login.");
  out("");

  let n = 0;
  for (const [key, arr] of dupKeys) {
    n++;
    out(`## ${n}. \`${key}\` — ${arr.length} accounts`);
    out("");
    out("| # | Collection | Name | Stored email | Created | Last updated | Fees (active/total) | Paid | Pending due | Test results | Exam results | Attendance | Notes |");
    out("|---|-----------|------|--------------|---------|--------------|---------------------|------|-------------|--------------|--------------|------------|-------|");
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      const s = await summarizers[a.model](a);
      out(
        `| ${i + 1} | ${a.model} | ${a.doc.name || "—"} | \`${a.doc.email}\` | ${fmtDate(a.doc.createdAt)} | ${fmtDate(a.doc.updatedAt)} | ${s.feesActive}/${s.feesRaw} | ${s.paidCount || "—"} | ${s.pendingDue ? s.pendingDue : "—"} | ${s.testResults || "—"} | ${s.examResults || "—"} | ${s.attendance || "—"} | ${s.extra} |`
      );
    }
    // ids for follow-up decisions
    out("");
    out("IDs: " + arr.map((a) => `${a.model}:${idOf(a)}`).join(" · "));
    // case-variant warning
    const variants = new Set(arr.map((a) => a.doc.email));
    if (variants.size > 1) out("⚠ Case/whitespace variants — exact-match login resolution is ambiguous.");
    // which one findOne would return for an exact query (natural order probe)
    out("");
  }

  if (dupKeys.length === 0) out("_No duplicate emails found — safe to add the unique index._");

  const text = L.join("\n");
  const target = process.argv[2] || "tmp/duplicate-emails-report.md";
  fs.mkdirSync(require("path").dirname(target), { recursive: true });
  fs.writeFileSync(target, text + "\n");
  console.log(text);
  console.log(`\n[saved to ${target}]`.green || `\n[saved to ${target}]`);
}

main()
  .then(() => mongoose.disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

