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

// Ensure PDF output directory exists
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// ─── Photo helpers ─────────────────────────────────────────────────────────────
// Shared resolver (handles remote URLs AND local /uploads paths) lives in
// utils/studentPhoto.js so exports and reports behave identically on
// local-storage deployments. See E-1.
const { loadStudentPhoto: resolveStudentPhoto } = require("../../utils/studentPhoto");

// ─── Shared card-style drawing primitives ──────────────────────────────────────
// Every PDF this service produces (result sheet, analytics, session report
// card) draws the same black-on-white chrome/info-grid/tables defined in
// utils/cardPdfStyle.js — layout/rendering only, no data logic.
const {
  CARD_BLACK,
  CARD_DASH,
  CARD_TABLE_X,
  CARD_TABLE_W,
  createCardChrome,
  strokeCardCell: cardStrokeCell,
  drawCenteredLines: cardCenteredLines,
  wrapCardLabel,
  clipCardLine,
  drawInfoGrid,
  drawCardTable,
} = require("../../utils/cardPdfStyle");

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

  // Page chrome (frame + centered logo/title block + footer), same as the
  // session report card.
  const chrome = createCardChrome(doc, {
    schoolName,
    title: "Test Result Sheet",
    subtitle: `${test.subject ? test.subject.name : ""} — ${test.name}`,
  });

  // Stats
  const passCount = results.filter((r) => r.score >= test.passMarks).length;
  // Finding 1.3: show meaningful message when test has zero results
  const passRate = results.length > 0 ? Math.round((passCount / results.length) * 100) : 0;

  // Labeled info grid: test meta + summary stats, black-on-white cells
  let y = drawInfoGrid(doc, {
    y: chrome.y,
    rows: [
      [{ label: "Test", value: test.name, size: 10 }],
      [
        { label: "Subject", value: test.subject ? test.subject.name : null },
        { label: "Date", value: new Date(test.date).toLocaleDateString() },
      ],
      [
        { label: "Total Marks", value: String(test.totalMarks) },
        { label: "Pass Marks", value: test.passMarks != null ? String(test.passMarks) : null },
      ],
      [
        { label: "Students", value: String(results.length) },
        { label: "Passed", value: results.length > 0 ? String(passCount) : null },
        { label: "Pass Rate", value: results.length > 0 ? `${passRate}%` : null },
      ],
    ],
  }) + 16;

  // Results table — pass/fail column only when the test actually has a pass mark
  const hasPass = Number(test.passMarks) > 0;
  if (results.length > 0) {
    const headers = hasPass ? ["Roll No", "Student", "Score / Max", "Status"] : ["Roll No", "Student", "Score / Max"];
    const colWidths = hasPass ? [80, 240, 105, 70] : [90, 260, 145];
    const aligns = hasPass ? ["center", "left", "center", "center"] : ["center", "left", "center"];
    const rows = results.map((r) => {
      // A student can be deleted out-of-band while their TestResult rows
      // remain, leaving r.student null after populate. Render a graceful "—"
      // row instead of throwing a 500.
      const stu = r.student || {};
      const line = [stu.rollNumber || CARD_DASH, stu.name || CARD_DASH, `${r.score}/${test.totalMarks}`];
      if (hasPass) line.push(r.score >= test.passMarks ? "Pass" : "Fail");
      return line;
    });
    y = drawCardTable(doc, y, { headers, rows, colWidths, aligns, chrome });
  } else {
    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(CARD_BLACK).text("No results recorded yet", CARD_TABLE_X, y);
    y += 20;
  }

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

// Single-student analytics: one row per test with the Subject column merged
// vertically across that subject's rows — the same merged-cell idea the
// session report card uses for its phase headers. Rows are sorted by subject,
// then date, purely for display grouping (no data change).
function drawSubjectMergedTable(doc, startY, rows, chrome) {
  const sorted = rows
    .slice()
    .sort((a, b) => String(a.subject).localeCompare(String(b.subject)) || new Date(a.date) - new Date(b.date));

  const x = CARD_TABLE_X;
  const colWidths = [105, 165, 85, 80, 60]; // sums to CARD_TABLE_W (495)
  const aligns = ["center", "left", "center", "center", "center"];
  const headers = ["Subject", "Test", "Date", "Score / Max", "%"];
  const fontSize = 9;
  const rowH = 20;
  const bottomLimit = () => doc.page.height - 92;
  const colX = (i) => x + colWidths.slice(0, i).reduce((a, b) => a + b, 0);

  let y = startY;
  const headerLines = headers.map((h, i) => wrapCardLabel(doc, h, colWidths[i] - 8, fontSize, 2));
  const hdrH = Math.max(...headerLines.map((l) => l.length)) * (fontSize + 3) + 6;
  const paintHeader = () => {
    headers.forEach((h, i) => {
      cardCenteredLines(doc, headerLines[i], colX(i) + 2, colWidths[i] - 4, y, hdrH, { font: "Helvetica-Bold", size: fontSize });
      cardStrokeCell(doc, colX(i), colWidths[i], y, hdrH, 0.75);
    });
    y += hdrH;
  };
  paintHeader();

  // A "segment" is the part of one merged subject cell that lives on a single
  // page; page turns close the old segment and reopen it under the new header.
  let group = null;
  let segTop = null;
  const closeSegment = (bottom) => {
    if (group === null || segTop === null) return;
    const h = bottom - segTop;
    if (h > 0) {
      cardStrokeCell(doc, colX(0), colWidths[0], segTop, h, 0.5);
      const maxLines = Math.max(1, Math.floor(h / (fontSize + 3)));
      cardCenteredLines(doc, wrapCardLabel(doc, group, colWidths[0] - 10, fontSize, maxLines), colX(0) + 5, colWidths[0] - 10, segTop, h, {
        font: "Helvetica-Bold",
        size: fontSize,
      });
    }
    segTop = null;
  };

  for (const r of sorted) {
    const newGroup = group === null || r.subject !== group;
    if (y + rowH > bottomLimit()) {
      closeSegment(y);
      doc.addPage();
      y = chrome.y;
      paintHeader();
      if (!newGroup) segTop = y; // group continues below the repeated header
    }
    if (newGroup) {
      closeSegment(y);
      group = r.subject;
      segTop = y;
    }

    const ry = y;
    doc.font("Helvetica").fontSize(fontSize).fillColor(CARD_BLACK);
    const cells = [r.test, new Date(r.date).toLocaleDateString(), `${r.score}/${r.totalMarks}`, r.percent !== null ? `${r.percent}%` : CARD_DASH];
    for (let i = 1; i < colWidths.length; i++) {
      const t = clipCardLine(doc, String(cells[i - 1]), colWidths[i] - 8, "Helvetica", fontSize);
      doc.text(t, colX(i) + 4, ry + (rowH - fontSize * 1.2) / 2, { width: colWidths[i] - 8, align: aligns[i] });
      cardStrokeCell(doc, colX(i), colWidths[i], ry, rowH, 0.5);
    }
    y = ry + rowH;
  }
  closeSegment(y);
  return y;
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

  const chrome = createCardChrome(doc, {
    schoolName,
    title: "Test Analytics Report",
    subtitle,
  });

  // Stats — same labeled black-on-white cells as the session card
  // Filter out rows where totalMarks is falsy (0 or undefined) to avoid NaN — Finding 2.1
  const validRows = rows.filter((r) => r.totalMarks);
  const avg = validRows.length > 0 ? Math.round((validRows.reduce((s, r) => s + r.percent, 0) / validRows.length) * 100) / 100 : 0;

  let y;
  if (studentName) {
    // Student info block: photo cell + label/value grid, like the report card
    y = drawInfoGrid(doc, {
      y: chrome.y,
      withPhoto: true,
      photoResult,
      rows: [
        [{ label: "Name", value: studentName, size: 11 }],
        [
          { label: "Roll No", value: rows[0] ? String(rows[0].rollNumber || "") : null },
          { label: "Student ID", value: rows[0] ? String(rows[0].studentId || "") : null },
        ],
      ],
    }) + 16;
  } else {
    y = chrome.y;
  }

  y = drawInfoGrid(doc, {
    y,
    rows: [
      [
        { label: "Results", value: String(rows.length) },
        { label: "Average", value: `${avg}%` },
      ],
    ],
  }) + 16;

  // Table
  if (rows.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(CARD_BLACK).text("No results recorded for this filter.", CARD_TABLE_X, y);
    y += 20;
  } else if (studentName) {
    y = drawSubjectMergedTable(doc, y, rows, chrome);
  } else {
    const headers = ["Student", "Roll No", "Test", "Subject", "Score", "%"];
    const colWidths = [130, 60, 120, 95, 50, 40];
    const aligns = ["left", "center", "left", "left", "center", "center"];
    const tableRows = rows.map((r) => [
      r.studentName,
      r.rollNumber || CARD_DASH,
      r.test,
      r.subject,
      `${r.score}/${r.totalMarks}`,
      r.percent !== null ? `${r.percent}%` : CARD_DASH,
    ]);
    y = drawCardTable(doc, y, { headers, rows: tableRows, colWidths, aligns, chrome });
  }

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

// ─── Session Report Card layout (black-on-white, one marks matrix) ─────────
// Layout/rendering only: the data shape (session, student, phases[], overallAverage,
// periodLabel) produced by gatherSessionReport / gatherSessionReportsBulk is
// consumed exactly as before. Its page chrome, info grid and cell rules come
// from utils/cardPdfStyle.js — the same primitives the Result Sheet and
// Analytics renderers now share, so every PDF has one visual language.

// Reshape phase blocks into a subjects × test-columns matrix. Within each
// phase, a subject's k-th test occupies the k-th sub-column, so parallel
// tests across subjects line up in the same column. Slots are derived from
// recorded results only; a subject missing slot k shows a dash.
function buildSubjectTable(phases = []) {
  const subjectSet = new Set();
  phases.forEach((pb) => pb.tests.forEach((t) => subjectSet.add(t.subject)));
  const subjects = [...subjectSet].sort((a, b) => String(a).localeCompare(String(b)));

  const groups = phases
    .map((pb) => {
      const slotsBySubject = new Map();
      pb.tests.forEach((t) => {
        if (!slotsBySubject.has(t.subject)) slotsBySubject.set(t.subject, []);
        slotsBySubject.get(t.subject).push(t);
      });
      const slotCount = Math.max(0, ...[...slotsBySubject.values()].map((list) => list.length));
      return { phase: pb.phase, slotCount, slotsBySubject };
    })
    .filter((g) => g.slotCount > 0);

  const columns = [];
  groups.forEach((g, gi) => {
    for (let s = 0; s < g.slotCount; s++) {
      const cellBySubject = {};
      g.slotsBySubject.forEach((list, subj) => {
        if (list[s]) cellBySubject[subj] = list[s];
      });
      columns.push({ gi, label: `Test ${s + 1}`, cellBySubject });
    }
  });

  return { subjects, groups, columns };
}

function renderSessionReportPdf(data, schoolName, photoResult) {
  const { session, student, phases, overallAverage, periodLabel } = data;
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const buffers = [];
  doc.on("data", (b) => buffers.push(b));

  const TABLE_X = CARD_TABLE_X;
  const TABLE_W = CARD_TABLE_W;
  const bottomLimit = () => doc.page.height - 92; // keep clear of the in-frame footer

  const strokeCardCell = (x, w, yy, h, lw = 0.5) => cardStrokeCell(doc, x, w, yy, h, lw);
  const drawCenteredLines = (lines, x, w, yy, h, opts) => cardCenteredLines(doc, lines, x, w, yy, h, opts);

  // ── Page chrome: thin outer frame, centred title block, in-frame footer ──
  const chrome = createCardChrome(doc, {
    schoolName,
    title: "Session Report Card",
    subtitle: periodLabel ? `${session.name} — ${periodLabel}` : session.name,
  });

  // ── Student info block: photo cell + label/value grid (not a paragraph) ──
  let y =
    drawInfoGrid(doc, {
      x: TABLE_X,
      w: TABLE_W,
      y: chrome.y,
      withPhoto: true,
      photoResult,
      rows: [
        [{ label: "Name", value: student.name, size: 11 }],
        [{ label: "Roll No", value: student.rollNumber }, { label: "Class / Section", value: student.className }],
        [{ label: "Father's Name", value: student.fatherName }, { label: "Student ID", value: student.studentId }],
      ],
    }) + 16;

  // ── Single marks table: rows = subjects, columns = phase test slots + Total ──
  const table = buildSubjectTable(phases);
  const nCols = table.columns.length;
  const cellOf = (subj, i) => table.columns[i].cellBySubject[subj] || null;

  // totalMarks context: if every recorded test shares one max, keep cells bare
  // and say so in a footnote; otherwise show score/max per cell.
  const allTotals = new Set();
  table.columns.forEach((c) => Object.values(c.cellBySubject).forEach((t) => allTotals.add(t.totalMarks)));
  const uniformTotal = allTotals.size === 1 && [...allTotals][0] > 0 ? [...allTotals][0] : null;
  const fmtCell = (t) => {
    if (!t) return CARD_DASH;
    if (uniformTotal !== null) return String(t.score);
    return t.totalMarks > 0 ? `${t.score}/${t.totalMarks}` : String(t.score);
  };

  if (nCols === 0) {
    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(CARD_BLACK)
      .text("No test results recorded for this period.", TABLE_X, y);
    y += 24;
  } else {
    // Font/column sizing: shrink rather than break the table when the session
    // has many phases/tests.
    const scoreFont = nCols <= 8 ? 9 : nCols <= 12 ? 8 : nCols <= 16 ? 7 : 6;
    const headFont = Math.min(10, scoreFont + 1);
    const subjW = nCols > 14 ? 88 : nCols > 10 ? 104 : 122;
    const totalW = nCols > 14 ? 44 : nCols > 10 ? 50 : 56;
    const testW = (TABLE_W - subjW - totalW) / nCols;
    const rowH = scoreFont + 9;
    const colXAt = (i) => TABLE_X + subjW + i * testW;

    const groupSpans = [];
    table.columns.forEach((c, i) => {
      const last = groupSpans[groupSpans.length - 1];
      if (!last || last.gi !== c.gi) groupSpans.push({ gi: c.gi, start: i, count: 1 });
      else last.count += 1;
    });
    const r1Lines = groupSpans.map((sp) => wrapCardLabel(doc, table.groups[sp.gi].phase, sp.count * testW - 8, headFont, 2));
    const r1H = Math.max(...r1Lines.map((l) => l.length)) * (headFont + 3) + 8;
    const r2Font = testW >= 30 ? headFont - 1 : Math.max(5, scoreFont - 1);
    const r2Lines = table.columns.map((c) => wrapCardLabel(doc, c.label, testW - 4, r2Font, 2));
    const r2H = Math.max(...r2Lines.map((l) => l.length)) * (r2Font + 3) + 6;

    const drawTableHeader = () => {
      const hy = y;
      strokeCardCell(TABLE_X, subjW, hy, r1H + r2H, 0.75);
      doc.font("Helvetica-Bold").fontSize(headFont).fillColor(CARD_BLACK)
        .text("Subject", TABLE_X + 5, hy + (r1H + r2H) / 2 - headFont * 0.6, { width: subjW - 10 });
      groupSpans.forEach((sp, k) => {
        const gx = colXAt(sp.start);
        strokeCardCell(gx, sp.count * testW, hy, r1H, 0.75);
        drawCenteredLines(r1Lines[k], gx + 4, sp.count * testW - 8, hy, r1H, { font: "Helvetica-Bold", size: headFont });
      });
      strokeCardCell(colXAt(nCols), totalW, hy, r1H + r2H, 0.75);
      drawCenteredLines(["Total"], colXAt(nCols) + 2, totalW - 4, hy, r1H + r2H, { font: "Helvetica-Bold", size: headFont });
      table.columns.forEach((c, i) => {
        strokeCardCell(colXAt(i), testW, hy + r1H, r2H, 0.5);
        drawCenteredLines(r2Lines[i], colXAt(i) + 1, testW - 2, hy + r1H, r2H, { font: "Helvetica", size: r2Font });
      });
      y = hy + r1H + r2H;
    };

    const drawRow = (cells, { bold = false } = {}) => {
      if (y + rowH > bottomLimit()) {
        doc.addPage();
        y = chrome.y;
        drawTableHeader();
      }
      const ry = y;
      const font = bold ? "Helvetica-Bold" : "Helvetica";
      doc.font(font).fontSize(scoreFont).fillColor(CARD_BLACK);
      cells.forEach((c) => {
        const t = c.align === "left" ? clipCardLine(doc, c.text, c.w - 8, font, scoreFont) : c.text;
        doc.text(t, c.x + 4, ry + (rowH - scoreFont * 1.2) / 2, { width: c.w - 8, align: c.align });
      });
      cells.forEach((c) => strokeCardCell(c.x, c.w, ry, rowH, 0.5));
      y = ry + rowH;
    };

    drawTableHeader();

    const colSums = new Array(nCols).fill(0);
    const colHasScore = new Array(nCols).fill(false);
    let grand = 0;

    table.subjects.forEach((subj) => {
      let subjSum = 0;
      const cells = [{ x: TABLE_X, w: subjW, text: String(subj), align: "left" }];
      for (let i = 0; i < nCols; i++) {
        const t = cellOf(subj, i);
        cells.push({ x: colXAt(i), w: testW, text: fmtCell(t), align: "center" });
        if (t) {
          subjSum += t.score;
          colSums[i] += t.score;
          colHasScore[i] = true;
        }
      }
      grand += subjSum;
      cells.push({ x: colXAt(nCols), w: totalW, text: String(subjSum), align: "center" });
      drawRow(cells);
    });

    // Total row: per-column sums + grand total
    const totalCells = [{ x: TABLE_X, w: subjW, text: "Total", align: "left" }];
    colSums.forEach((s, i) => {
      totalCells.push({ x: colXAt(i), w: testW, text: colHasScore[i] ? String(s) : CARD_DASH, align: "center" });
    });
    totalCells.push({ x: colXAt(nCols), w: totalW, text: String(grand), align: "center" });
    drawRow(totalCells, { bold: true });
    y += 14;

    // ── Overall percentage + footnotes (needs ~70pt clearance for its lines) ──
    if (y + 70 > bottomLimit()) {
      doc.addPage();
      y = chrome.y;
    }
    doc.font("Helvetica-Bold").fontSize(11).fillColor(CARD_BLACK)
      .text(`Overall Percentage: ${overallAverage !== null ? `${overallAverage}%` : CARD_DASH}`, TABLE_X, y);
    y += 15;

    const phaseAvgs = phases.filter((p) => p.average !== null).map((p) => `${p.phase}: ${p.average}%`);
    doc.font("Helvetica").fontSize(7.5).fillColor(CARD_BLACK)
      .text(
        `Overall percentage is provisional — the simple average of phase averages${phaseAvgs.length ? ` (${phaseAvgs.join("; ")})` : ""}. ` +
          (uniformTotal !== null
            ? `All tests are marked out of ${uniformTotal} marks; the Total column and Total row sum raw marks. A dash means the subject has no test recorded for that column.`
            : "Cells show marks scored against each test's total; the Total column and Total row sum raw marks. A dash means the subject has no test recorded for that column."),
        TABLE_X,
        y,
        { width: TABLE_W }
      );
  }

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

// Drawing-only internals — exported so layout tests can exercise the merged
// subject table (multi-row groups + page-break segments) without DB data.
exports._cardInternals = { drawSubjectMergedTable };

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
