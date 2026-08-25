const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");

const Test = require("../../models/Academic/test.model");
const TestResult = require("../../models/Academic/testResult.model");
const TestSession = require("../../models/Academic/testSession.model");
const Student = require("../../models/Students/students.model");

const PDF_DIR = path.join(__dirname, "../../tmp/pdfs");
const LOGO_PATH = path.join(__dirname, "../../public/images/logo.png");

// Ensure PDF output directory exists
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// ─── Shared PDF drawing helpers ────────────────────────────────────────────────

function drawHeader(doc, { schoolName, title, subtitle }) {
  const hasLogo = fs.existsSync(LOGO_PATH);
  const leftMargin = doc.page.margins.left;
  const topMargin = doc.page.margins.top;

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
  doc.moveTo(leftMargin, lineY).lineTo(550, lineY).strokeColor("#ddd").lineWidth(1).stroke();

  return lineY + 10;
}

function drawTable(doc, startY, { headers, rows, colWidths }) {
  let y = startY;
  const leftMargin = doc.page.margins.left;
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
      y = doc.page.margins.top;
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

  const results = await TestResult.find({ test: testId }).populate("student", "name studentId whatsappNumber");

  return { test, results };
}

async function gatherAnalytics({ studentId, subjectId, fromDate, toDate }) {
  const testQuery = {};
  if (subjectId) testQuery.subject = subjectId;
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

  const results = await TestResult.find(resultQuery)
    .populate("student", "name studentId whatsappNumber")
    .populate({ path: "test", populate: { path: "subject", select: "name" } });

  const rows = results.map((r) => ({
    studentName: r.student.name,
    studentId: r.student.studentId,
    whatsappNumber: r.student.whatsappNumber,
    test: r.test.name,
    subject: r.test.subject ? r.test.subject.name : "Unknown",
    date: r.test.date,
    score: r.score,
    totalMarks: r.test.totalMarks,
    percent: Math.round((r.score / r.test.totalMarks) * 10000) / 100,
  }));

  // Determine if scope resolves to exactly one student
  const uniqueStudents = [...new Set(results.map((r) => r.student._id.toString()))];
  let studentName = null;
  let whatsappNumber = null;
  if (uniqueStudents.length === 1) {
    studentName = rows[0].studentName;
    whatsappNumber = rows[0].whatsappNumber;
  }

  return { rows, studentName, whatsappNumber };
}

async function gatherSessionReport(sessionId, studentId) {
  const session = await TestSession.findById(sessionId);
  if (!session) return null;

  const student = await Student.findById(studentId).select("name studentId whatsappNumber fatherName classLevel");
  if (!student) return null;

  const tests = await Test.find({ session: sessionId }).populate("subject", "name");
  const testIds = tests.map((t) => t._id);

  const results = await TestResult.find({ test: { $in: testIds }, student: studentId });
  const resultByTest = {};
  results.forEach((r) => {
    resultByTest[r.test.toString()] = r.score;
  });

  const phaseBlocks = session.phases
    .sort((a, b) => a.order - b.order)
    .map((phase) => {
      const phaseTests = tests.filter((t) => t.phase && t.phase.toString() === phase._id.toString());
      const rows = phaseTests
        .filter((t) => resultByTest[t._id.toString()] !== undefined)
        .map((t) => ({
          test: t.name,
          subject: t.subject ? t.subject.name : "Unknown",
          score: resultByTest[t._id.toString()],
          totalMarks: t.totalMarks,
          percent: Math.round((resultByTest[t._id.toString()] / t.totalMarks) * 10000) / 100,
        }));

      const phaseAverage =
        rows.length > 0
          ? Math.round((rows.reduce((sum, r) => sum + r.percent, 0) / rows.length) * 100) / 100
          : null;

      return { phase: phase.name, order: phase.order, tests: rows, average: phaseAverage };
    });

  const phasesWithScores = phaseBlocks.filter((p) => p.average !== null);
  const overallAverage =
    phasesWithScores.length > 0
      ? Math.round((phasesWithScores.reduce((sum, p) => sum + p.average, 0) / phasesWithScores.length) * 100) / 100
      : null;

  // Populate class level name
  const classLevelPop = student.classLevel
    ? await require("../../models/Academic/class.model").findById(student.classLevel).select("name")
    : null;

  return {
    session: { _id: session._id, name: session.name },
    student: {
      name: student.name,
      studentId: student.studentId,
      whatsappNumber: student.whatsappNumber,
      fatherName: student.fatherName,
      className: classLevelPop ? classLevelPop.name : "—",
    },
    phases: phaseBlocks,
    overallAverage,
  };
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
  const passRate = results.length > 0 ? Math.round((passCount / results.length) * 100) : 0;

  drawStatBox(doc, 50, y, String(results.length), "Students");
  drawStatBox(doc, 170, y, String(passCount), "Passed");
  drawStatBox(doc, 290, y, `${passRate}%`, "Pass Rate");
  y += 50;

  // Results table
  if (results.length > 0) {
    const headers = ["Student", "ID", "Score", "%", "Status"];
    const colWidths = [180, 100, 70, 70, 80];
    const rows = results.map((r) => {
      const pct = Math.round((r.score / test.totalMarks) * 10000) / 100;
      return [r.student.name, r.student.studentId, `${r.score}/${test.totalMarks}`, `${pct}%`, r.score >= test.passMarks ? "Pass" : "Fail"];
    });
    drawTable(doc, y, { headers, rows, colWidths });
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

function generateAnalyticsPDF(data, schoolName, filters) {
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

  // Stats
  const avg = rows.length > 0 ? Math.round((rows.reduce((s, r) => s + r.percent, 0) / rows.length) * 100) / 100 : 0;
  drawStatBox(doc, 50, y, String(rows.length), "Results");
  drawStatBox(doc, 170, y, `${avg}%`, "Average");
  y += 50;

  // Table
  if (rows.length > 0) {
    const headers = studentName ? ["Test", "Subject", "Date", "Score", "%"] : ["Student", "Test", "Subject", "Score", "%"];
    const colWidths = studentName ? [130, 120, 80, 70, 70] : [150, 110, 100, 70, 70];
    const rows_data = rows.map((r) =>
      studentName
        ? [r.test, r.subject, new Date(r.date).toLocaleDateString(), `${r.score}/${r.totalMarks}`, `${r.percent}%`]
        : [r.studentName, r.test, r.subject, `${r.score}/${r.totalMarks}`, `${r.percent}%`]
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

function generateSessionReportPDF(data, schoolName) {
  const { session, student, phases, overallAverage } = data;
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const buffers = [];
  doc.on("data", (b) => buffers.push(b));

  let y = drawHeader(doc, {
    schoolName,
    title: "Session Report Card",
    subtitle: `${session.name}`,
  });

  // Student info box
  doc.fillStyle = "#f0f4f8";
  doc.rect(50, y, 495, 55).fill();
  doc.fillColor("#1e3a5f").fontSize(12).font("Helvetica-Bold");
  doc.text(student.name, 60, y + 8);
  doc.fillColor("#555").fontSize(9).font("Helvetica");
  doc.text(`ID: ${student.studentId}`, 60, y + 25);
  doc.text(`Father: ${student.fatherName}`, 200, y + 25);
  doc.text(`Class: ${student.className}`, 370, y + 25);
  y += 65;

  // Overall average
  drawStatBox(doc, 50, y, overallAverage !== null ? `${overallAverage}%` : "—", "Overall Average");
  y += 50;

  // Phase blocks
  phases.forEach((phaseBlock) => {
    if (y > 680) {
      doc.addPage();
      y = doc.page.margins.top;
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
      const rows = phaseBlock.tests.map((t) => [t.test, t.subject, `${t.score}/${t.totalMarks}`, `${t.percent}%`]);
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

exports.generateAnalyticsPDF = async (filters, schoolName) => {
  const data = await gatherAnalytics(filters);
  return generateAnalyticsPDF(data, schoolName, filters);
};

exports.generateSessionReportPDF = async (sessionId, studentId, schoolName) => {
  const data = await gatherSessionReport(sessionId, studentId);
  if (!data) throw new Error("Session or student not found");
  return generateSessionReportPDF(data, schoolName);
};

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
