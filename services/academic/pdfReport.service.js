const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");

const Test = require("../../models/Academic/test.model");
const TestResult = require("../../models/Academic/testResult.model");
const TestSession = require("../../models/Academic/testSession.model");
const Student = require("../../models/Students/students.model");
const ClassLevel = require("../../models/Academic/class.model");
const Week = require("../../models/Academic/week.model");

const PDF_DIR = path.join(__dirname, "../../tmp/pdfs");
const LOGO_PATH = path.join(__dirname, "../../public/images/logo.jpg");

// Ensure PDF output directory exists
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// ─── Photo helpers ─────────────────────────────────────────────────────────────
// Shared resolver (handles remote URLs AND local /uploads paths) lives in
// utils/studentPhoto.js so exports and reports behave identically on
// local-storage deployments. See E-1.
const { loadStudentPhoto: resolveStudentPhoto } = require("../../utils/studentPhoto");

// ─── Shared PDF drawing helpers ────────────────────────────────────────────────

const HEADER_RESERVE = 68; // vertical space used by drawHeader (logo + titles + divider + gap)

/**
 * Draw the repeating page header (logo + school name + title + subtitle + divider).
 * Registers a `pageAdded` listener so the header is redrawn on every new page.
 * Returns the Y position where body content should start.
 */
function drawHeader(doc, { schoolName, title, subtitle }) {
  const hasLogo = fs.existsSync(LOGO_PATH);
  const leftMargin = doc.page.margins.left;
  const topMargin = doc.page.margins.top;
  const pageW = doc.page.width;

  function paintHeader() {
    if (hasLogo) {
      try {
        doc.image(LOGO_PATH, leftMargin, topMargin, { width: 48, height: 48 });
      } catch {
        // logo corrupt — skip silently
      }
    }

    const textX = hasLogo ? leftMargin + 58 : leftMargin;
    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .fillColor("#1e3a5f")
      .text(schoolName || "School Portal", textX, topMargin + 2);

    doc
      .fontSize(13)
      .font("Helvetica-Bold")
      .fillColor("#333")
      .text(title, textX, topMargin + 22);

    if (subtitle) {
      doc
        .fontSize(10)
        .font("Helvetica")
        .fillColor("#666")
        .text(subtitle, textX, topMargin + 40);
    }

    // Divider line
    const lineY = hasLogo ? topMargin + 56 : topMargin + 50;
    doc.moveTo(leftMargin, lineY).lineTo(pageW - leftMargin - doc.page.margins.right, lineY).strokeColor("#ddd").lineWidth(1).stroke();
  }

  // Paint on first page
  paintHeader();

  // Re-paint on every subsequent page
  doc.on("pageAdded", () => {
    paintHeader();
  });

  return topMargin + HEADER_RESERVE;
}

function drawTable(doc, startY, { headers, rows, colWidths }) {
  let y = startY;
  const leftMargin = doc.page.margins.left;
  const topMargin = doc.page.margins.top;
  const rowHeight = 22;
  const headerHeight = 24;

  // Header row
  doc.fillStyle = "#1e3a5f";
  doc.rect(leftMargin, y, 550 - leftMargin - doc.page.margins.right, headerHeight).fill();

  doc.fillColor("#ffffff").fontSize(9).font("Helvetica-Bold");
  let x = leftMargin + 6;
  headers.forEach((h, i) => {
    doc.text(h, x, y + 7, { width: colWidths[i] - 8, align: i > 0 ? "right" : "left" });
    x += colWidths[i];
  });
  y += headerHeight;

  // Data rows
  doc.font("Helvetica").fontSize(9);
  rows.forEach((row, ri) => {
    if (y > 750) {
      doc.addPage();
      // Start below the repeating page header (drawn by pageAdded handler)
      y = topMargin + HEADER_RESERVE;
    }

    // Alternating row background
    if (ri % 2 === 0) {
      doc.fillStyle = "#f8f9fa";
      doc.rect(leftMargin, y, 550 - leftMargin - doc.page.margins.right, rowHeight).fill();
    }

    doc.fillColor("#333");
    x = leftMargin + 6;
    row.forEach((cell, i) => {
      const align = i > 0 ? "right" : "left";
      doc.text(String(cell), x, y + 7, { width: colWidths[i] - 8, align });
      x += colWidths[i];
    });
    y += rowHeight;
  });

  return y;
}

function drawStatBox(doc, x, y, value, label) {
  doc
    .fillColor("#1e3a5f")
    .fontSize(16)
    .font("Helvetica-Bold")
    .text(value, x, y, { width: 100, align: "center" });
  doc
    .fillColor("#666")
    .fontSize(8)
    .font("Helvetica")
    .text(label, x, y + 20, { width: 100, align: "center" });
}

function drawFooter(doc) {
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  doc
    .fontSize(7)
    .font("Helvetica")
    .fillColor("#aaa")
    .text(
      `Generated ${new Date().toLocaleString()} — School Management System`,
      doc.page.margins.left,
      pageH - 30,
      { width: pageW - doc.page.margins.left - doc.page.margins.right, align: "center" }
    );
}

// ─── Data gathering (reuses existing model queries) ────────────────────────────

async function gatherResultSheet(testId) {
  const test = await Test.findById(testId)
    .populate("subject", "name")
    .populate("classLevels", "name");
  if (!test) return null;

  const results = await TestResult.find({ test: testId }).populate("student", "name studentId rollNumber whatsappNumber");

  return { test, results };
}

async function gatherAnalytics({ studentId, subjectId, fromDate, toDate }, scope) {
  const testQuery = {};
  if (subjectId) {
    testQuery.subject = subjectId;
  } else if (scope) {
    // No explicit subject but a teacher scope: restrict to the teacher's own subjects.
    testQuery.subject = { $in: scope.teacherSubjectIds };
  }
  if (fromDate || toDate) {
    testQuery.date = {};
    if (fromDate) testQuery.date.$gte = new Date(fromDate);
    if (toDate) testQuery.date.$lte = new Date(toDate);
  }

  const tests = await Test.find(testQuery).populate("subject", "name");
  const testIds = tests.map((t) => t._id);
  if (testIds.length === 0) return { rows: [], studentName: null };

  const resultQuery = { test: { $in: testIds } };
  if (studentId) resultQuery.student = studentId;

  const resultsRaw = await TestResult.find(resultQuery)
    .populate("student", "name studentId rollNumber whatsappNumber photoUrl classLevel")
    .populate({ path: "test", populate: { path: "subject", select: "name" } });

  // Teacher scope: keep only results whose (test subject × student classLevel)
  // pair is an actual assignment. This is the intersection the controller could
  // not enforce purely from the requested filters (e.g. subject given but no
  // student, or neither given).
  const results = scope
    ? resultsRaw.filter((r) => {
        const subId = r.test && r.test.subject ? (r.test.subject._id || r.test.subject).toString() : null;
        const clsId = r.student && r.student.classLevel ? r.student.classLevel.toString() : null;
        if (!subId || !clsId) return false;
        const classSet = scope.subjectClassMap[subId];
        return !!(classSet && classSet.has(clsId));
      })
    : resultsRaw;

  if (results.length === 0) return { rows: [], studentName: null };

  const rows = results.map((r) => {
    const percent = r.test.totalMarks
      ? Math.round((r.score / r.test.totalMarks) * 10000) / 100
      : null;
    return {
      studentName: r.student.name,
      studentId: r.student.studentId,
      rollNumber: r.student.rollNumber,
      whatsappNumber: r.student.whatsappNumber,
      test: r.test.name,
      subject: r.test.subject ? r.test.subject.name : "Unknown",
      date: r.test.date,
      score: r.score,
      totalMarks: r.test.totalMarks,
      percent,
    };
  });

  // Determine if scope resolves to exactly one student
  const uniqueStudents = [...new Set(results.map((r) => r.student._id.toString()))];
  let studentName = null;
  let whatsappNumber = null;
  let studentPhotoUrl = null;
  if (uniqueStudents.length === 1) {
    studentName = rows[0].studentName;
    whatsappNumber = rows[0].whatsappNumber;
    studentPhotoUrl = results[0].student.photoUrl || null;
  }

  return { rows, studentName, whatsappNumber, studentPhotoUrl };
}

// ─── Session-report period filtering helpers ───────────────────────────────
// A session report can cover the whole session or just one phase / one week
// inside it. Week beats phase when both are given (a week always lives inside
// a phase). Kept as pure functions so the bulk path and unit tests share one
// implementation.
function filterTestsByPeriod(tests, period = {}) {
  if (period && period.weekId) {
    return tests.filter((t) => String((t.week && t.week._id) || t.week || "") === String(period.weekId));
  }
  if (period && period.phaseId) {
    return tests.filter((t) => t.phase && String(t.phase._id || t.phase) === String(period.phaseId));
  }
  return tests;
}

async function resolvePeriodLabel(session, period = {}) {
  if (!period) return null;
  const phases = (session && session.phases) || [];
  if (period.weekId) {
    const week = await Week.findById(period.weekId).select("name phase").lean();
    if (!week) return null;
    const phase = phases.find((p) => String(p._id) === String(week.phase));
    return [phase && phase.name, `Week: ${week.name}`].filter(Boolean).join(" — ");
  }
  if (period.phaseId) {
    const phase = phases.find((p) => String(p._id) === String(period.phaseId));
    return phase ? phase.name : null;
  }
  return null;
}

// Shared row builder — guards the percent division against totalMarks = 0.
function buildSessionRows(testList, resultByTest) {
  return testList
    .filter((t) => resultByTest[String(t._id)] !== undefined)
    .map((t) => {
      const score = resultByTest[String(t._id)];
      const totalMarks = t.totalMarks;
      return {
        test: t.name,
        subject: t.subject ? t.subject.name : "Unknown",
        score,
        totalMarks,
        percent: totalMarks ? Math.round((score / totalMarks) * 10000) / 100 : null,
      };
    });
}

function averagePercent(rows) {
  const valid = rows.filter((r) => r.percent !== null);
  return valid.length > 0 ? Math.round((valid.reduce((sum, r) => sum + r.percent, 0) / valid.length) * 100) / 100 : null;
}

// Group the (already period-filtered) tests into the session's phase blocks.
// D-1: session tests with no phase would otherwise be dropped from the
// report card entirely. Give them an explicit block so their scores are
// never silently missing from the parent-facing PDF.
function buildPhaseBlocks(sessionPhases, tests, resultByTest) {
  const phaseBlocks = (sessionPhases || [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((phase) => {
      const phaseTests = tests.filter((t) => t.phase && String(t.phase._id || t.phase) === String(phase._id));
      const rows = buildSessionRows(phaseTests, resultByTest);
      return { phase: phase.name, order: phase.order, tests: rows, average: averagePercent(rows) };
    });

  const ungroupedRows = buildSessionRows(tests.filter((t) => !t.phase), resultByTest);
  if (ungroupedRows.length > 0) {
    phaseBlocks.push({ phase: "Not grouped into a phase", order: null, tests: ungroupedRows, average: averagePercent(ungroupedRows) });
  }
  return phaseBlocks;
}

function overallAverageOf(phases) {
  const phasesWithScores = phases.filter((p) => p.average !== null);
  return phasesWithScores.length > 0
    ? Math.round((phasesWithScores.reduce((sum, p) => sum + p.average, 0) / phasesWithScores.length) * 100) / 100
    : null;
}

async function gatherSessionReport(sessionId, studentId, period = {}) {
  const session = await TestSession.findById(sessionId);
  if (!session) return null;

  const student = await Student.findById(studentId).select("name studentId rollNumber whatsappNumber fatherName classLevel photoUrl");
  if (!student) return null;

  const allTests = await Test.find({ session: sessionId }).populate("subject", "name");
  const tests = filterTestsByPeriod(allTests, period);
  const testIds = tests.map((t) => t._id);

  const results = await TestResult.find({ test: { $in: testIds }, student: studentId });
  const resultByTest = {};
  results.forEach((r) => {
    resultByTest[r.test.toString()] = r.score;
  });

  const phaseBlocks = buildPhaseBlocks(session.phases, tests, resultByTest);
  const overallAverage = overallAverageOf(phaseBlocks);

  // Populate class level name
  const classLevelPop = student.classLevel
    ? await require("../../models/Academic/class.model").findById(student.classLevel).select("name")
    : null;

  const periodLabel = await resolvePeriodLabel(session, period);

  return {
    session: { _id: session._id, name: session.name },
    student: {
      name: student.name,
      studentId: student.studentId,
      rollNumber: student.rollNumber,
      whatsappNumber: student.whatsappNumber,
      fatherName: student.fatherName,
      className: classLevelPop ? classLevelPop.name : "—",
      photoUrl: student.photoUrl,
    },
    phases: phaseBlocks,
    overallAverage,
    periodLabel,
  };
}

// Bulk variant: one round of queries for the whole roster, then per-student
// report payloads shaped exactly like the single-student gather above so the
// same PDF renderer handles both paths.
async function gatherSessionReportsBulk({ sessionId, studentIds, period = {} }) {
  const session = await TestSession.findById(sessionId).lean();
  if (!session) throw new Error("Session not found");

  const students = await Student.find({ _id: { $in: studentIds } })
    .select("name studentId rollNumber whatsappNumber fatherName classLevel photoUrl")
    .sort("rollNumber name")
    .lean();

  const classIds = [...new Set(students.map((s) => s.classLevel).filter(Boolean))];
  const classDocs = await ClassLevel.find({ _id: { $in: classIds } }).select("name").lean();
  const classNameById = {};
  classDocs.forEach((c) => {
    classNameById[String(c._id)] = c.name;
  });

  const allTests = await Test.find({ session: sessionId }).populate("subject", "name").lean();
  const tests = filterTestsByPeriod(allTests, period);
  const testIds = tests.map((t) => String(t._id));

  const results =
    testIds.length > 0
      ? await TestResult.find({ test: { $in: testIds }, student: { $in: studentIds } }).lean()
      : [];

  const byStudent = {};
  results.forEach((r) => {
    const sid = String(r.student && r.student._id ? r.student._id : r.student);
    const tid = String(r.test && r.test._id ? r.test._id : r.test);
    (byStudent[sid] = byStudent[sid] || {})[tid] = r.score;
  });

  const periodLabel = await resolvePeriodLabel(session, period);

  return students.map((student) => {
    const resultByTest = byStudent[String(student._id)] || {};
    const phaseBlocks = buildPhaseBlocks(session.phases, tests, resultByTest);
    const data = {
      session: { _id: session._id, name: session.name },
      student: {
        name: student.name,
        studentId: student.studentId,
        rollNumber: student.rollNumber,
        whatsappNumber: student.whatsappNumber,
        fatherName: student.fatherName,
        className: classNameById[String(student.classLevel)] || "—",
        photoUrl: student.photoUrl,
      },
      phases: phaseBlocks,
      overallAverage: overallAverageOf(phaseBlocks),
      periodLabel,
    };
    // A student with no recorded result inside the selected period would
    // produce an empty report card — flag it so the caller can skip it.
    const hasResults = phaseBlocks.some((p) => p.tests.length > 0);
    return { data, hasResults };
  });
}

// ─── PDF generation functions ──────────────────────────────────────────────────

function generateResultSheetPDF(data, schoolName) {
  const { test, results } = data;
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const buffers = [];
  doc.on("data", (b) => buffers.push(b));

  // Header
  let y = drawHeader(doc, {
    schoolName,
    title: "Test Result Sheet",
    subtitle: `${test.subject ? test.subject.name : ""} — ${test.name}`,
  });

  // Test info
  doc.fillColor("#333").fontSize(10).font("Helvetica");
  doc.text(`Date: ${new Date(test.date).toLocaleDateString()}`, 50, y);
  doc.text(`Total Marks: ${test.totalMarks}`, 200, y);
  doc.text(`Pass Marks: ${test.passMarks}`, 350, y);
  y += 20;

  // Stats
  const passCount = results.filter((r) => r.score >= test.passMarks).length;
  // Finding 1.3: show meaningful message when test has zero results
  const passRate = results.length > 0 ? Math.round((passCount / results.length) * 100) : 0;

  drawStatBox(doc, 50, y, String(results.length), "Students");
  drawStatBox(doc, 170, y, results.length > 0 ? String(passCount) : "—", "Passed");
  drawStatBox(doc, 290, y, results.length > 0 ? `${passRate}%` : "—", "Pass Rate");
  y += 50;

  // Results table
  if (results.length > 0) {
    const headers = ["Student", "Roll No", "ID", "Score", "%", "Status"];
    const colWidths = [150, 60, 90, 70, 60, 70];
    const rows = results.map((r) => {
      const pct = test.totalMarks ? Math.round((r.score / test.totalMarks) * 10000) / 100 : null;
      // A student can be deleted out-of-band while their TestResult rows
      // remain, leaving r.student null after populate. Render a graceful "—"
      // row instead of throwing a 500.
      const stu = r.student || {};
      return [stu.name || "—", stu.rollNumber || "—", stu.studentId || "—", `${r.score}/${test.totalMarks}`, pct !== null ? `${pct}%` : "—", r.score >= test.passMarks ? "Pass" : "Fail"];
    });
    drawTable(doc, y, { headers, rows, colWidths });
  } else {
    doc.fillColor("#999").fontSize(10).font("Helvetica-Oblique");
    doc.text("No results recorded yet", 50, y);
    y += 20;
  }

  drawFooter(doc);
  doc.end();

  return new Promise((resolve) => {
    doc.on("end", () => {
      const uuid = crypto.randomUUID();
      const filePath = path.join(PDF_DIR, `${uuid}.pdf`);
      fs.writeFileSync(filePath, Buffer.concat(buffers));
      resolve({ uuid, filePath, studentCount: results.length, singleStudent: null });
    });
  });
}

function generateAnalyticsPDF(data, schoolName, filters, photoResult) {
  const { rows, studentName } = data;
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const buffers = [];
  doc.on("data", (b) => buffers.push(b));

  const subtitle = studentName
    ? `Report for: ${studentName}`
    : [filters.subjectId ? `Subject filtered` : null, filters.fromDate ? `From: ${filters.fromDate}` : null, filters.toDate ? `To: ${filters.toDate}` : null]
        .filter(Boolean)
        .join(" | ") || "All results";

  let y = drawHeader(doc, {
    schoolName,
    title: "Test Analytics Report",
    subtitle,
  });

  // Student photo + info strip when scoped to a single student with a photo
  if (studentName && photoResult && photoResult.buffer) {
    const PHOTO_SIZE = 54;
    const stripH = 40;
    doc.fillStyle = "#f0f4f8";
    doc.rect(50, y, 495, stripH).fill();
    try {
      doc.image(photoResult.buffer, 56, y + (stripH - PHOTO_SIZE) / 2, {
        width: PHOTO_SIZE,
        height: PHOTO_SIZE,
        fit: [PHOTO_SIZE, PHOTO_SIZE],
      });
    } catch {
      // photo corrupt — skip
    }
    doc.fillColor("#1e3a5f").fontSize(10).font("Helvetica-Bold");
    doc.text(studentName, 118, y + 13);
    y += stripH + 10;
  }

  // Stats
  // Filter out rows where totalMarks is falsy (0 or undefined) to avoid NaN — Finding 2.1
  const validRows = rows.filter((r) => r.totalMarks);
  const avg = validRows.length > 0 ? Math.round((validRows.reduce((s, r) => s + r.percent, 0) / validRows.length) * 100) / 100 : 0;
  drawStatBox(doc, 50, y, String(rows.length), "Results");
  drawStatBox(doc, 170, y, `${avg}%`, "Average");
  y += 50;

  // Table
  if (rows.length > 0) {
    const headers = studentName ? ["Test", "Subject", "Date", "Score", "%"] : ["Student", "Roll No", "Test", "Subject", "Score", "%"];
    const colWidths = studentName ? [130, 120, 80, 70, 70] : [120, 60, 100, 90, 60, 60];
    const rows_data = rows.map((r) =>
      studentName
        ? [r.test, r.subject, new Date(r.date).toLocaleDateString(), `${r.score}/${r.totalMarks}`, `${r.percent !== null ? r.percent : "—"}%`]
        : [r.studentName, r.rollNumber || "—", r.test, r.subject, `${r.score}/${r.totalMarks}`, `${r.percent !== null ? r.percent : "—"}%`]
    );
    drawTable(doc, y, { headers, rows: rows_data, colWidths });
  }

  drawFooter(doc);
  doc.end();

  return new Promise((resolve) => {
    doc.on("end", () => {
      const uuid = crypto.randomUUID();
      const filePath = path.join(PDF_DIR, `${uuid}.pdf`);
      fs.writeFileSync(filePath, Buffer.concat(buffers));
      const singleStudent = studentName ? { name: studentName, whatsapp: data.whatsappNumber } : null;
      resolve({ uuid, filePath, studentCount: rows.length, singleStudent });
    });
  });
}

function renderSessionReportPdf(data, schoolName, photoResult) {
  const { session, student, phases, overallAverage, periodLabel } = data;
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const buffers = [];
  doc.on("data", (b) => buffers.push(b));

  let y = drawHeader(doc, {
    schoolName,
    title: "Session Report Card",
    subtitle: periodLabel ? `${session.name} — ${periodLabel}` : `${session.name}`,
  });

  // Student info box (taller to accommodate passport photo on the right)
  const PHOTO_SIZE = 72; // 1 inch
  const infoBoxH = photoResult ? 80 : 55;
  doc.fillStyle = "#f0f4f8";
  doc.rect(50, y, 495, infoBoxH).fill();

  // Student photo (right side of info box)
  if (photoResult && photoResult.buffer) {
    try {
      const photoX = 50 + 495 - PHOTO_SIZE - 6;
      const photoY = y + (infoBoxH - PHOTO_SIZE) / 2;
      doc.image(photoResult.buffer, photoX, photoY, {
        width: PHOTO_SIZE,
        height: PHOTO_SIZE,
        fit: [PHOTO_SIZE, PHOTO_SIZE],
      });
    } catch {
      // photo corrupt or unsupported format — skip silently
    }
  }

  // Text area: keep within the left portion when photo is present
  const textMaxWidth = photoResult ? 495 - PHOTO_SIZE - 20 : 495 - 20;
  doc.fillColor("#1e3a5f").fontSize(12).font("Helvetica-Bold");
  doc.text(student.name, 60, y + 8, { width: textMaxWidth });
  doc.fillColor("#555").fontSize(9).font("Helvetica");
  doc.text(`Roll No: ${student.rollNumber || "—"}  |  ID: ${student.studentId}`, 60, y + 25);
  doc.text(`Father: ${student.fatherName}`, 200, y + 25);
  doc.text(`Class: ${student.className}`, 370, y + 25);
  y += infoBoxH + 10;

  // Overall average
  drawStatBox(doc, 50, y, overallAverage !== null ? `${overallAverage}%` : "—", "Overall Average");
  y += 50;

  // Phase blocks
  phases.forEach((phaseBlock) => {
    if (y > 680) {
      doc.addPage();
      y = doc.page.margins.top + HEADER_RESERVE;
    }

    doc.fillColor("#1e3a5f").fontSize(11).font("Helvetica-Bold");
    doc.text(phaseBlock.phase, 50, y);
    if (phaseBlock.average !== null) {
      doc.fillColor("#666").fontSize(9).font("Helvetica");
      doc.text(`${phaseBlock.average}% average`, 200, y + 2);
    }
    y += 18;

    if (phaseBlock.tests.length > 0) {
      const headers = ["Test", "Subject", "Score", "%"];
      const colWidths = [180, 150, 80, 80];
      const rows = phaseBlock.tests.map((t) => [t.test, t.subject, `${t.score}/${t.totalMarks}`, t.percent !== null ? `${t.percent}%` : "—"]);
      y = drawTable(doc, y, { headers, rows, colWidths });
    } else {
      doc.fillColor("#999").fontSize(9).font("Helvetica-Oblique");
      doc.text("No results in this phase yet", 60, y);
      y += 20;
    }
    y += 10;
  });

  drawFooter(doc);
  doc.end();

  return new Promise((resolve) => {
    doc.on("end", () => {
      const uuid = crypto.randomUUID();
      const filePath = path.join(PDF_DIR, `${uuid}.pdf`);
      fs.writeFileSync(filePath, Buffer.concat(buffers));
      const singleStudent = { name: student.name, whatsapp: student.whatsappNumber };
      resolve({ uuid, filePath, studentCount: 1, singleStudent });
    });
  });
}

// ─── Public API ────────────────────────────────────────────────────────────────

exports.generateResultSheetPDF = async (testId, schoolName) => {
  const data = await gatherResultSheet(testId);
  if (!data) throw new Error("Test not found");
  return generateResultSheetPDF(data, schoolName);
};

exports.generateAnalyticsPDF = async (filters, schoolName, scope) => {
  const data = await gatherAnalytics(filters, scope);
  const photoResult = data.studentPhotoUrl ? await resolveStudentPhoto(data.studentPhotoUrl) : null;
  return generateAnalyticsPDF(data, schoolName, filters, photoResult);
};

exports.generateSessionReportPDF = async (sessionId, studentId, schoolName, period = {}) => {
  const data = await gatherSessionReport(sessionId, studentId, period);
  if (!data) throw new Error("Session or student not found");
  const photoResult = await resolveStudentPhoto(data.student.photoUrl);
  return renderSessionReportPdf(data, schoolName, photoResult);
};

// Bulk: one PDF per student for a class / set of sections, optionally narrowed
// to one phase or week. Students with no results in the period are skipped
// (an empty report card is noise for the parent) and surfaced as `skipped`
// entries so the UI can explain why. Photos are resolved through a per-batch
// cache so a class sharing one storage URL is fetched once.
exports.generateSessionReportBulkPDFs = async ({ sessionId, studentIds, phaseId, weekId }, schoolName) => {
  const period = { phaseId, weekId };
  const items = await gatherSessionReportsBulk({ sessionId, studentIds, period });
  const photoCache = new Map();
  const reports = [];

  for (const item of items) {
    const stu = item.data.student;
    const base = {
      name: stu.name,
      rollNumber: stu.rollNumber || "—",
      className: stu.className,
      whatsapp: stu.whatsappNumber || "",
    };

    if (!item.hasResults) {
      reports.push({ ...base, status: "skipped" });
      continue;
    }

    let photoResult = null;
    if (stu.photoUrl) {
      if (!photoCache.has(stu.photoUrl)) photoCache.set(stu.photoUrl, await resolveStudentPhoto(stu.photoUrl));
      photoResult = photoCache.get(stu.photoUrl);
    }

    const rendered = await renderSessionReportPdf(item.data, schoolName, photoResult);
    reports.push({
      ...base,
      status: "generated",
      uuid: rendered.uuid,
      pdfUrl: `/reports/pdf/${rendered.uuid}`,
    });
  }

  return reports;
};

// Pure shaping helpers — exported for unit tests (period filter + phase blocks).
exports._sessionReportInternals = { filterTestsByPeriod, buildPhaseBlocks, buildSessionRows, averagePercent, overallAverageOf };

exports.getPdfPath = (uuid) => {
  const filePath = path.join(PDF_DIR, `${uuid}.pdf`);
  return fs.existsSync(filePath) ? filePath : null;
};

// Cleanup PDFs older than 1 hour (called periodically)
exports.cleanupOldPdfs = () => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour
  try {
    const files = fs.readdirSync(PDF_DIR);
    files.forEach((f) => {
      const fp = path.join(PDF_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(fp);
      }
    });
  } catch {
    // ignore
  }
};
