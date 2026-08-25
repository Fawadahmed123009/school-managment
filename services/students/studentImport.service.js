const XLSX = require("xlsx");
const fs = require("fs");
const responseStatus = require("../../handlers/responseStatus.handler");
const Student = require("../../models/Students/students.model");
const ClassLevel = require("../../models/Academic/class.model");
const { hashPassword } = require("../../handlers/passHash.handler");

function buildCandidateClassName(row) {
  const grade = String(row["Class"] || "").trim();
  const group = String(row["Group"] || "").trim();
  const section = String(row["Section"] || "").trim();

  if (!grade) return null;
  if (grade.toUpperCase() === "PG") return "PG";
  if (!group && !section) return `${grade}th`;
  return `${grade}th ${group} ${section}`.trim();
}

exports.parseStudentExcelService = async (filePath, res) => {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

  const classLevels = await ClassLevel.find({});
  const classByName = {};
  classLevels.forEach((c) => { classByName[c.name] = c._id.toString(); });

  const staged = rows.map((row) => {
    const name = String(row["Name"] || "").trim();
    const admissionNumber = String(row["Admission Number"] || "").trim();
    const rollNumberRaw = row["Roll #"] ?? row["Roll Number"] ?? "";
    const candidateClassName = buildCandidateClassName(row);
    const matchedClassId = candidateClassName ? classByName[candidateClassName] || null : null;

    return {
      name,
      admissionNumber,
      rollNumber: rollNumberRaw !== "" ? Number(rollNumberRaw) : null,
      rawClassText: candidateClassName,
      matchedClassId,
      fatherName: String(row["Father Name"] || "").trim() || undefined,
      address: String(row["Address"] || "").trim() || undefined,
      whatsappNumber: String(row["WhatsApp"] || row["Whatsapp Number"] || row["Phone"] || "").trim() || undefined,
      feeAgreed: row["Fee"] !== undefined && row["Fee"] !== "" ? row["Fee"] : undefined,
      gender: String(row["Gender"] || "").trim() || undefined,
    };
  }).filter((r) => r.name);

  fs.unlink(filePath, () => {});

  return responseStatus(res, 200, "success", staged);
};

exports.bulkCreateStudentsFromImportService = async (rows, res) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return responseStatus(res, 400, "failed", "No student rows provided");
  }

  const created = [];
  const skipped = [];

  // Track roll numbers used within THIS batch, per class, so two rows in the
  // same import that both claim "Roll #5" in the same class don't both pass.
  const usedInBatch = new Set();

  for (const row of rows) {
    const { name, admissionNumber, classLevel, rollNumber,
            fatherName, address, whatsappNumber, feeAgreed, gender } = row;

    if (!name || !classLevel) {
      const reason = "Missing name or class";
      console.log(`[IMPORT SKIP] name="${name}" classLevel="${classLevel}" roll="${rollNumber}" → ${reason}`);
      skipped.push({ row, reason });
      continue;
    }

    if (rollNumber === undefined || rollNumber === null || rollNumber === "") {
      const reason = "Missing roll number";
      console.log(`[IMPORT SKIP] name="${name}" classLevel="${classLevel}" → ${reason}`);
      skipped.push({ row, reason });
      continue;
    }

    const rollNum = Number(rollNumber);
    if (Number.isNaN(rollNum)) {
      const reason = "Roll number must be a number";
      console.log(`[IMPORT SKIP] name="${name}" roll="${rollNumber}" → ${reason}`);
      skipped.push({ row, reason });
      continue;
    }

    const batchKey = `${classLevel}:${rollNum}`;
    if (usedInBatch.has(batchKey)) {
      const reason = `Roll number ${rollNum} used twice in this import for this class`;
      console.log(`[IMPORT SKIP] name="${name}" class="${classLevel}" roll="${rollNum}" → ${reason}`);
      skipped.push({ row, reason });
      continue;
    }

    const rollTaken = await Student.findOne({ classLevel, rollNumber: rollNum });
    if (rollTaken) {
      const reason = `Roll number ${rollNum} already used in this class`;
      console.log(`[IMPORT SKIP] name="${name}" class="${classLevel}" roll="${rollNum}" → ${reason}`);
      skipped.push({ row, reason });
      continue;
    }

    const emailBase = admissionNumber
      ? `adm${admissionNumber}`
      : `${name.toLowerCase().replace(/\s+/g, "")}${Math.floor(1000 + Math.random() * 9000)}`;
    const email = `${emailBase}@school.local`;

    const existingEmail = await Student.findOne({ email });
    if (existingEmail) {
      const reason = "Student already exists (duplicate admission number)";
      console.log(`[IMPORT SKIP] name="${name}" admission="${admissionNumber}" email="${email}" → ${reason}`);
      skipped.push({ row, reason });
      continue;
    }

    try {
      const tempPassword = Math.random().toString(36).slice(-8);
      const studentData = {
        name,
        email,
        password: await hashPassword(tempPassword),
        classLevel,
        rollNumber: rollNum,
      };

      // Optional fields — use Excel values if present, otherwise model defaults
      if (fatherName) studentData.fatherName = fatherName;
      if (address) studentData.address = address;
      if (whatsappNumber) studentData.whatsappNumber = whatsappNumber;
      if (feeAgreed !== undefined && feeAgreed !== null && feeAgreed !== "") {
        const fee = Number(feeAgreed);
        if (!Number.isNaN(fee)) studentData.feeAgreed = fee;
      }
      if (gender === "Female") studentData.gender = "Female";

      const student = await Student.create(studentData);

      usedInBatch.add(batchKey);
      created.push({ ...student.toObject(), tempPassword });
    } catch (err) {
      skipped.push({ row, reason: `Save failed: ${err.message}` });
    }
  }

  // Log skip summary grouped by reason
  if (skipped.length > 0) {
    const reasonCounts = {};
    skipped.forEach((s) => { reasonCounts[s.reason] = (reasonCounts[s.reason] || 0) + 1; });
    console.log(`\n[IMPORT SUMMARY] Created: ${created.length}, Skipped: ${skipped.length}`);
    console.log("[IMPORT SKIP REASONS]");
    Object.entries(reasonCounts).forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count}`);
    });
    console.log("");
  }

  return responseStatus(res, 201, "success", { created, skipped });
};

exports.exportStudentsService = async (res) => {
  const students = await Student.find({}).populate("classLevel", "name");

  const rows = students.map((s) => ({
    "Roll #": s.rollNumber ?? "",
    Name: s.name,
    "Student ID": s.studentId,
    Email: s.email,
    Class: s.classLevel ? s.classLevel.name : "",
    "Date Admitted": s.dateAdmitted ? s.dateAdmitted.toISOString().slice(0, 10) : "",
    Status: s.isWithdrawn ? "Withdrawn" : s.isGraduated ? "Graduated" : s.isSuspended ? "Suspended" : "Active",
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Students");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Disposition", "attachment; filename=students-export.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buffer);
};
