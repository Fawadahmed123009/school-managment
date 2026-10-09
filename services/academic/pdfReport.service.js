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

  const results = await TestResult.find({ test: testId }).populate("student", "name studentId rollNumber whatsappNumber classLevel");

  return { test, results };
}

// Result-sheet grade/section scoping: the chosen test may target several
// class sections (e.g. Grade 9–10, Boys + Girls). When the picker has a
// grade and/or section selected, the PDF must list ONLY the pupils whose own
// class matches — a "Boys" sheet never shows Girls pupils, and the stats
// (students/passed/average) follow the narrowed list. An empty value means no
// narrowing; "none" is the no-grade/no-section bucket.
async function narrowResultsByCategory(results, filters = {}) {
  const grade = filters.grade ? String(filters.grade) : null;
  const section = filters.section ? String(filters.section) : null;
  if (!grade && !section) return results;

  const classIds = results
    .map((r) => (r.student && r.student.classLevel ? String(r.student.classLevel._id || r.student.classLevel) : null))
    .filter(Boolean);
  const classes = await ClassLevel.find({ _id: { $in: classIds } })
    .select("gradeLevel section sectionRef")
    .populate("sectionRef", "name")
    .lean();

  const keep = new Set();
  classes.forEach((c) => {
    const g = c.gradeLevel ? String(c.gradeLevel) : "none";
    const s = (c.sectionRef && c.sectionRef.name) || c.section || "none";
    if (grade && g !== grade) return;
    if (section && s !== section) return;
    keep.add(String(c._id));
  });

  return results.filter((r) => r.student && r.student.classLevel && keep.has(String(r.student.classLevel._id || r.student.classLevel)));
}

async function gatherAnalytics({ studentId, subjectId, period, grade, section, testId }, scope) {
  period = period || {};
  const testQuery = {};
  // A chosen session bounds the whole report; the period cascade (weekIds >
  // weekId > phaseId, shared with the session report) narrows within it. With
  // no session at all the report falls back to the legacy school-wide query,
  // still narrowed by any period selectors and always scoped for teachers.
  if (period.sessionId) testQuery.session = period.sessionId;
  // A single chosen test narrows the report to just that test's results; with no
  // test picked the report aggregates every matching test ("All tests").
  if (testId) testQuery._id = testId;
  if (subjectId) {
    testQuery.subject = subjectId;
  } else if (scope) {
    // No explicit subject but a teacher scope: restrict to the teacher's own subjects.
    testQuery.subject = { $in: scope.teacherSubjectIds };
  }

  let tests = await Test.find(testQuery).populate("subject", "name").populate("week", "name startDate");
  tests = filterTestsByPeriod(tests, period);
  const testIds = tests.map((t) => t._id);
  if (testIds.length === 0) return { rows: [], studentName: null, mode: "single-week", periodLabel: null };

  const resultQuery = { test: { $in: testIds } };
  if (studentId) resultQuery.student = studentId;

  const resultsRaw = await TestResult.find(resultQuery)
    .populate("student", "name studentId rollNumber whatsappNumber photoUrl classLevel")
    .populate({
      path: "test",
      populate: [
        { path: "subject", select: "name" },
        { path: "week", select: "name startDate" },
      ],
    });

  // Teacher scope: keep only results whose (test subject × student classLevel)
  // pair is an actual assignment. This is the intersection the controller could
  // not enforce purely from the requested filters (e.g. subject given but no
  // student, or neither given).
  let results = scope
    ? resultsRaw.filter((r) => {
        const subId = r.test && r.test.subject ? (r.test.subject._id || r.test.subject).toString() : null;
        const clsId = r.student && r.student.classLevel ? r.student.classLevel.toString() : null;
        if (!subId || !clsId) return false;
        const classSet = scope.subjectClassMap[subId];
        return !!(classSet && classSet.has(clsId));
      })
    : resultsRaw;

  // Grade / Section narrow which pupils appear (the same class-metadata scoping
  // the result sheet uses — resolved against each student's own classLevel). An
  // empty value means no narrowing, so the helper only runs when one is set.
  if (grade || section) results = await narrowResultsByCategory(results, { grade, section });

  if (results.length === 0) return { rows: [], studentName: null, mode: "single-week", periodLabel: null };

  const rows = results.map((r) => {
    const percent = r.test.totalMarks
      ? Math.round((r.score / r.test.totalMarks) * 10000) / 100
      : null;
    // Week metadata drives the analytics mode layouts: populated week → its id/
    // name; a test outside any week buckets as "No week" (never dropped).
    const week = r.test.week && r.test.week._id ? r.test.week : null;
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
      weekId: week ? String(week._id) : null,
      weekName: week ? week.name : null,
      weekStart: week ? week.startDate : null,
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

  // Period label under the header: session name plus phase/week narrowing,
  // resolved by the same helper the session report card uses.
  let periodLabel = null;
  if (period.sessionId) {
    const session = await TestSession.findById(period.sessionId);
    periodLabel = (await resolvePeriodLabel(session, period)) || (session ? session.name : null);
  }

  const mode = detectAnalyticsMode(rows, period);

  return { rows, studentName, whatsappNumber, studentPhotoUrl, periodLabel, mode };
}

// ─── Session-report period filtering helpers ───────────────────────────────
// A session report can cover the whole session, one phase, one week, or a
// explicitly chosen SET of weeks (the "combine multiple weeks" mode). The
// narrowest selector wins: an explicit week set (weekIds) beats a single week,
// which beats a phase — so ticking 2 of 4 weeks in a phase yields only those
// two weeks' tests, never the whole phase. Kept as pure functions so the bulk
// path and unit tests share one implementation.
function weekIdOf(t) {
  return String((t.week && t.week._id) || t.week || "");
}

function filterTestsByPeriod(tests, period = {}) {
  if (period && Array.isArray(period.weekIds) && period.weekIds.length > 0) {
    const wanted = new Set(period.weekIds.map(String));
    return tests.filter((t) => wanted.has(weekIdOf(t)));
  }
  if (period && period.weekId) {
    return tests.filter((t) => weekIdOf(t) === String(period.weekId));
  }
  if (period && period.phaseId) {
    return tests.filter((t) => t.phase && String(t.phase._id || t.phase) === String(period.phaseId));
  }
  return tests;
}

async function resolvePeriodLabel(session, period = {}) {
  if (!period) return null;
  const phases = (session && session.phases) || [];
  if (Array.isArray(period.weekIds) && period.weekIds.length > 0) {
    const weeks = await Week.find({ _id: { $in: period.weekIds } }).select("name phase").sort("startDate").lean();
    if (weeks.length === 0) return null;
    // Label by phase when all picked weeks share one phase; otherwise list the
    // week names (a combined set can span phases).
    const phaseIds = [...new Set(weeks.map((w) => String(w.phase || "")))];
    const names = weeks.map((w) => w.name).join(", ");
    if (phaseIds.length === 1) {
      const phase = phases.find((p) => String(p._id) === phaseIds[0]);
      return [phase && phase.name, `Weeks: ${names}`].filter(Boolean).join(" — ");
    }
    return `Weeks: ${names}`;
  }
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
// Each row also carries the test's week metadata (populated week → id/name/
// start; a bare/unpopulated week still yields its id so mode detection never
// mis-buckets it). The session report reshapes its layout from these rows
// using the SAME detectAnalyticsMode the analytics PDF uses, so week info must
// survive the session gather exactly as it does in gatherAnalytics.
function buildSessionRows(testList, resultByTest) {
  return testList
    .filter((t) => resultByTest[String(t._id)] !== undefined)
    .map((t) => {
      const score = resultByTest[String(t._id)];
      const totalMarks = t.totalMarks;
      const weekPop = t.week && t.week._id ? t.week : null;
      return {
        test: t.name,
        subject: t.subject ? t.subject.name : "Unknown",
        score,
        totalMarks,
        percent: totalMarks ? Math.round((score / totalMarks) * 10000) / 100 : null,
        weekId: weekPop ? String(weekPop._id) : t.week ? String(t.week) : null,
        weekName: weekPop ? weekPop.name : null,
        weekStart: weekPop ? weekPop.startDate : null,
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

// ─── Analytics report modes ──────────────────────────────────────────────────
// The analytics PDF reshapes itself around how wide the chosen period is:
//   • single-week — results live in one week: a flat test list, nothing grouped;
//   • full-phase  — a phase was picked with no week narrowing: group by subject
//                    and list every individual test under it;
//   • multi-week  — two or more weeks (ticked set or whole session): group by
//                    subject with ONE aggregated row per week under each subject.
// Mode + grouping are pure functions over the gathered rows so unit tests can
// exercise every shape without a database.

// Percentage label for group/totals rows: (score / outOf * 100) at one decimal,
// "N/A" whenever the out-of is zero or missing (never NaN/Infinity).
function analyticsPercentLabel(score, outOf) {
  if (!outOf || !(Number(outOf) > 0)) return "N/A";
  return ((Number(score) / Number(outOf)) * 100).toFixed(1) + "%";
}

const NO_WEEK_KEY = "\u0000no-week"; // bucket key for tests outside any week

function detectAnalyticsMode(rows, period = {}) {
  const weeks = new Set(rows.map((r) => (r.weekId ? String(r.weekId) : NO_WEEK_KEY)));
  if (weeks.size <= 1) return "single-week";
  const hasWeekSet = Array.isArray(period.weekIds) && period.weekIds.length > 0;
  if (period.phaseId && !period.weekId && !hasWeekSet) return "full-phase";
  return "multi-week";
}

// Split rows into one section per student, roll-number first (natural numeric
// compare, name as tie-breaker) so a multi-student report reads like a roster.
function groupRowsByStudent(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const key = String(r.studentId || r.studentName || "");
    if (!map.has(key)) {
      map.set(key, { student: { name: r.studentName, rollNumber: r.rollNumber, studentId: r.studentId }, rows: [] });
    }
    map.get(key).rows.push(r);
  });
  return [...map.values()].sort(
    (a, b) =>
      String(a.student.rollNumber || "").localeCompare(String(b.student.rollNumber || ""), undefined, { numeric: true, sensitivity: "base" }) ||
      String(a.student.name || "").localeCompare(String(b.student.name || ""), undefined, { numeric: true, sensitivity: "base" })
  );
}

// Multi-week shape: subject → one row per week (scores of that week's tests
// summed, out-of summed), weeks in calendar order, totals + percentage bottomed.
function buildSubjectWeekGroups(rows) {
  const bySubject = new Map();
  rows.forEach((r) => {
    const subj = String(r.subject || "Unknown");
    if (!bySubject.has(subj)) bySubject.set(subj, new Map());
    const weeks = bySubject.get(subj);
    const wkey = r.weekId ? String(r.weekId) : NO_WEEK_KEY;
    if (!weeks.has(wkey)) {
      weeks.set(wkey, {
        label: r.weekName || "No week",
        start: r.weekStart ? new Date(r.weekStart) : r.date ? new Date(r.date) : null,
        score: 0,
        outOf: 0,
      });
    }
    const w = weeks.get(wkey);
    w.score += Number(r.score) || 0;
    w.outOf += Number(r.totalMarks) || 0;
  });
  return [...bySubject.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([subject, weeks]) => {
      const lines = [...weeks.values()]
        .sort((x, y) => (x.start && y.start && x.start - y.start !== 0 ? x.start - y.start : 0) || String(x.label).localeCompare(String(y.label)))
        .map((w) => ({ label: w.label, score: w.score, outOf: w.outOf, percent: analyticsPercentLabel(w.score, w.outOf) }));
      const totalScore = lines.reduce((s, l) => s + l.score, 0);
      const totalOutOf = lines.reduce((s, l) => s + l.outOf, 0);
      return { subject, lines, totalScore, totalOutOf, percent: analyticsPercentLabel(totalScore, totalOutOf) };
    });
}

// Full-phase shape: subject → one row per individual test (name, date, score,
// out-of) in date order, totals + percentage bottomed.
function buildSubjectTestGroups(rows) {
  const bySubject = new Map();
  rows.forEach((r) => {
    const subj = String(r.subject || "Unknown");
    if (!bySubject.has(subj)) bySubject.set(subj, []);
    bySubject.get(subj).push(r);
  });
  return [...bySubject.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([subject, list]) => {
      const lines = list
        .slice()
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .map((r) => ({
          test: r.test,
          date: r.date,
          score: Number(r.score) || 0,
          outOf: Number(r.totalMarks) || 0,
          percent: analyticsPercentLabel(Number(r.score) || 0, Number(r.totalMarks) || 0),
        }));
      const totalScore = lines.reduce((s, l) => s + l.score, 0);
      const totalOutOf = lines.reduce((s, l) => s + l.outOf, 0);
      return { subject, lines, totalScore, totalOutOf, percent: analyticsPercentLabel(totalScore, totalOutOf) };
    });
}

async function gatherSessionReport(sessionId, studentId, period = {}) {
  const session = await TestSession.findById(sessionId);
  if (!session) return null;

  const student = await Student.findById(studentId).select("name studentId rollNumber whatsappNumber fatherName classLevel photoUrl");
  if (!student) return null;

  const allTests = await Test.find({ session: sessionId }).populate("subject", "name").populate("week", "name startDate");
  const tests = filterTestsByPeriod(allTests, period);
  const testIds = tests.map((t) => t._id);

  const results = await TestResult.find({ test: { $in: testIds }, student: studentId });
  const resultByTest = {};
  results.forEach((r) => {
    resultByTest[r.test.toString()] = r.score;
  });

  const phaseBlocks = buildPhaseBlocks(session.phases, tests, resultByTest);
  const overallAverage = overallAverageOf(phaseBlocks);

  // Flat, period-filtered rows (one per scored test) carry week metadata, so the
  // renderer can pick its layout with the same detectAnalyticsMode the analytics
  // report uses: a single week → flat subject table, 2+ weeks → subject groups
  // of week rows, a whole phase → the existing phase-column matrix.
  const rows = buildSessionRows(tests, resultByTest);
  const mode = detectAnalyticsMode(rows, period);

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
    rows,
    mode,
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

  const allTests = await Test.find({ session: sessionId }).populate("subject", "name").populate("week", "name startDate").lean();
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
    // Same reshape as the single-student path: flat week-tagged rows drive the
    // layout mode so every card in the batch matches the chosen period scope.
    const rows = buildSessionRows(tests, resultByTest);
    const mode = detectAnalyticsMode(rows, period);
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
      rows,
      mode,
      overallAverage: overallAverageOf(phaseBlocks),
      periodLabel,
    };
    // A student with no recorded result inside the selected period would
    // produce an empty report card — flag it so the caller can skip it.
    const hasResults = rows.length > 0;
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

  // Class average (percentage) — absent pupils (score 0 + absent flag, the
  // placeholder the marking services store) are excluded, same rule as the
  // roster UI and the marking statistics.
  const hasPct = Number(test.totalMarks) > 0;
  const marked = results.filter((r) => !r.absent);
  const classAverage =
    hasPct && marked.length > 0
      ? Math.round((marked.reduce((s, r) => s + (r.score / test.totalMarks) * 100, 0) / marked.length) * 100) / 100
      : null;

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
        { label: "Class Average", value: classAverage !== null ? `${classAverage}%` : null },
      ],
    ],
  }) + 16;

  // Results table — percentage column (score as % of total marks) instead of
  // pass/fail status; shown whenever the test has a positive total to divide by.
  // Absent pupils show "A" in place of the score/percentage (the 0 stored on
  // their row is only a placeholder).
  if (results.length > 0) {
    const headers = hasPct
      ? ["Roll No", "Student", "Obtained", "Total Marks", "Percentage"]
      : ["Roll No", "Student", "Obtained", "Total Marks"];
    const colWidths = hasPct ? [70, 205, 65, 75, 80] : [80, 235, 85, 95];
    const aligns = hasPct ? ["center", "left", "center", "center", "center"] : ["center", "left", "center", "center"];
    const rows = results.map((r) => {
      // A student can be deleted out-of-band while their TestResult rows
      // remain, leaving r.student null after populate. Render a graceful "—"
      // row instead of throwing a 500.
      const stu = r.student || {};
      const absent = Boolean(r.absent);
      // Obtained and Total marks now live in separate columns. An absent pupil
      // shows "A" for obtained but keeps the test's full marks in the Total
      // column (the maximum is the same for everyone).
      const line = [stu.rollNumber || CARD_DASH, stu.name || CARD_DASH, absent ? "A" : String(r.score), String(test.totalMarks)];
      if (hasPct) {
        if (absent) {
          line.push("A");
        } else {
          const percent = Math.round((r.score / test.totalMarks) * 10000) / 100;
          line.push(`${percent}%`);
        }
      }
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

// ─── Analytics PDF layouts ───────────────────────────────────────────────────
// Single-week stays a simple flat table (nothing grouped). Multi-week and
// full-phase render one section per student: for every subject a bordered
// table of week rows (aggregated) or test rows (individual), closed by a
// Total line with total score, total out-of and the percentage. All drawing
// reuses the shared card primitives, so the report keeps the system's
// black-on-white visual language.
function drawAnalyticsGroupedTables(doc, startY, rows, mode, chrome) {
  const bottomLimit = () => doc.page.height - 92;
  const sections = groupRowsByStudent(rows);
  const multiStudent = sections.length > 1;

  const tableShape =
    mode === "multi-week"
      ? { headers: ["Week", "Obtained", "Total Marks", "%"], colWidths: [255, 80, 80, 80], aligns: ["left", "center", "center", "center"] }
      : { headers: ["Test", "Date", "Obtained", "Total Marks", "%"], colWidths: [205, 80, 65, 70, 75], aligns: ["left", "center", "center", "center", "center"] };

  let y = startY;
  sections.forEach((sec) => {
    if (multiStudent) {
      if (y + 24 > bottomLimit()) {
        doc.addPage();
        y = chrome.y;
      }
      const label = `${sec.student.name || "—"}${sec.student.rollNumber ? ` \u2014 Roll ${sec.student.rollNumber}` : ""}`;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(CARD_BLACK).text(clipCardLine(doc, label, CARD_TABLE_W, "Helvetica-Bold", 10), CARD_TABLE_X, y);
      y += 20;
    }
    const groups = mode === "multi-week" ? buildSubjectWeekGroups(sec.rows) : buildSubjectTestGroups(sec.rows);
    groups.forEach((g) => {
      // Keep the subject label attached to at least a header + one row.
      if (y + 56 > bottomLimit()) {
        doc.addPage();
        y = chrome.y;
      }
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(CARD_BLACK).text(g.subject, CARD_TABLE_X, y);
      y += 16;
      const lines = g.lines.map((l) =>
        mode === "multi-week"
          ? [l.label, String(l.score), String(l.outOf), l.percent]
          : [l.test, new Date(l.date).toLocaleDateString(), String(l.score), String(l.outOf), l.percent]
      );
      const totalsRow =
        mode === "multi-week"
          ? ["Total", String(g.totalScore), String(g.totalOutOf), g.percent]
          : ["Total", "", String(g.totalScore), String(g.totalOutOf), g.percent];
      y = drawCardTable(doc, y, { ...tableShape, rows: [...lines, totalsRow], chrome });
      y += 14;
    });
  });
  return y;
}

function generateAnalyticsPDF(data, schoolName, filters, photoResult) {
  const { rows, studentName } = data;
  const mode = data.mode || detectAnalyticsMode(rows, (filters && filters.period) || {});
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const buffers = [];
  doc.on("data", (b) => buffers.push(b));

  const subtitleBits = [];
  if (studentName) subtitleBits.push(`Report for: ${studentName}`);
  if (data.periodLabel) subtitleBits.push(data.periodLabel);
  const subtitle = subtitleBits.length > 0 ? subtitleBits.join(" — ") : "All results";

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

  // Table — layout follows the detected period mode.
  if (rows.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(CARD_BLACK).text("No results recorded for this filter.", CARD_TABLE_X, y);
    y += 20;
  } else if (mode !== "single-week") {
    y = drawAnalyticsGroupedTables(doc, y, rows, mode, chrome);
  } else if (studentName) {
    // Single week, one pupil: a flat test list — subject/date ordering only
    // groups like-subjects visually, no merged cells, no totals.
    const sorted = rows
      .slice()
      .sort((a, b) => String(a.subject).localeCompare(String(b.subject)) || new Date(a.date) - new Date(b.date));
    const headers = ["Test", "Date", "Subject", "Obtained", "Total Marks", "%"];
    const colWidths = [125, 80, 120, 55, 65, 50];
    const aligns = ["left", "center", "left", "center", "center", "center"];
    const tableRows = sorted.map((r) => [
      r.test,
      new Date(r.date).toLocaleDateString(),
      r.subject,
      String(r.score),
      String(r.totalMarks),
      r.percent !== null ? `${r.percent}%` : "N/A",
    ]);
    y = drawCardTable(doc, y, { headers, rows: tableRows, colWidths, aligns, chrome });
  } else {
    // Single week, many pupils: one row per scored test, Obtained and Total
    // Marks in separate columns, roster-ordered by roll number.
    const sorted = rows
      .slice()
      .sort(
        (a, b) =>
          String(a.rollNumber || "").localeCompare(String(b.rollNumber || ""), undefined, { numeric: true, sensitivity: "base" }) ||
          String(a.studentName || "").localeCompare(String(b.studentName || "")) ||
          String(a.subject).localeCompare(String(b.subject)) ||
          new Date(a.date) - new Date(b.date)
      );
    const headers = ["Student", "Roll No", "Test", "Subject", "Obtained", "Total Marks", "%"];
    const colWidths = [115, 50, 105, 85, 55, 45, 40];
    const aligns = ["left", "center", "left", "left", "center", "center", "center"];
    const tableRows = sorted.map((r) => [
      r.studentName,
      r.rollNumber || CARD_DASH,
      r.test,
      r.subject,
      String(r.score),
      String(r.totalMarks),
      r.percent !== null ? `${r.percent}%` : "N/A",
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

// Single-week session card: a flat per-subject table. With one week in scope,
// every subject collapses to a single Obtained / Total Marks line (all that
// subject's tests in the week summed). buildSubjectWeekGroups already sums per
// week, so a group's totalScore/totalOutOf/percent are the one-row-per-subject
// values; a bold Total line closes the table.
function drawSessionSingleWeekTable(doc, startY, groups, chrome) {
  const headers = ["Subject", "Obtained", "Total Marks", "Percentage"];
  const colWidths = [225, 80, 90, 100];
  const aligns = ["left", "center", "center", "center"];
  const tableRows = groups.map((g) => [g.subject, String(g.totalScore), String(g.totalOutOf), g.percent]);
  const grandScore = groups.reduce((s, g) => s + g.totalScore, 0);
  const grandOutOf = groups.reduce((s, g) => s + g.totalOutOf, 0);
  tableRows.push(["Total", String(grandScore), String(grandOutOf), analyticsPercentLabel(grandScore, grandOutOf)]);
  return drawCardTable(doc, startY, { headers, rows: tableRows, colWidths, aligns, chrome });
}

// Multi-week session card: one bordered block per subject — the subject label,
// then a table of that subject's weeks (name, obtained, out-of, %) closed by a
// per-subject Total line. Mirrors the analytics multi-week grouped layout, but
// for a single pupil's report card.
function drawSessionMultiWeekGroups(doc, startY, groups, chrome) {
  const bottomLimit = () => doc.page.height - 92;
  const tableShape = { headers: ["Week", "Obtained", "Total Marks", "%"], colWidths: [255, 80, 80, 80], aligns: ["left", "center", "center", "center"] };
  let y = startY;
  groups.forEach((g) => {
    if (y + 56 > bottomLimit()) {
      doc.addPage();
      y = chrome.y;
    }
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(CARD_BLACK)
      .text(clipCardLine(doc, g.subject, CARD_TABLE_W, "Helvetica-Bold", 9.5), CARD_TABLE_X, y);
    y += 16;
    const lines = g.lines.map((l) => [l.label, String(l.score), String(l.outOf), l.percent]);
    const totalsRow = ["Total", String(g.totalScore), String(g.totalOutOf), g.percent];
    y = drawCardTable(doc, y, { ...tableShape, rows: [...lines, totalsRow], chrome });
    y += 14;
  });
  return y;
}

function renderSessionReportPdf(data, schoolName, photoResult) {
  const { session, student, phases, overallAverage, periodLabel } = data;
  // Layout mode + flat week-tagged rows come from the gather step. An older
  // payload without them defaults to the classic full-phase matrix.
  const mode = data.mode || "full-phase";
  const flatRows = data.rows || [];
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

  // ── Marks area: layout follows the chosen period scope, using the SAME
  // detectAnalyticsMode the analytics PDF uses. A single week renders a flat
  // per-subject table; 2+ weeks group by subject with one row per week and a
  // per-subject Total line; a whole phase keeps the classic matrix below.
  if (mode === "single-week" || mode === "multi-week") {
    if (flatRows.length === 0) {
      doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(CARD_BLACK)
        .text("No test results recorded for this period.", TABLE_X, y);
      y += 24;
    } else {
      const groups = buildSubjectWeekGroups(flatRows);
      y =
        mode === "single-week"
          ? drawSessionSingleWeekTable(doc, y, groups, chrome)
          : drawSessionMultiWeekGroups(doc, y, groups, chrome);

      const grandScore = groups.reduce((s, g) => s + g.totalScore, 0);
      const grandOutOf = groups.reduce((s, g) => s + g.totalOutOf, 0);
      if (y + 60 > bottomLimit()) {
        doc.addPage();
        y = chrome.y;
      }
      y += 4;
      doc.font("Helvetica-Bold").fontSize(11).fillColor(CARD_BLACK)
        .text(`Overall Percentage: ${analyticsPercentLabel(grandScore, grandOutOf)}`, TABLE_X, y);
      y += 15;
      doc.font("Helvetica").fontSize(7.5).fillColor(CARD_BLACK)
        .text(
          mode === "single-week"
            ? "One row per subject for the selected week. Obtained and Total Marks combine every test recorded for that subject in the week; the percentage is obtained \u00F7 total marks."
            : "Subjects are grouped with one row per selected week (that week's tests summed) and a per-subject Total line. The percentage is obtained \u00F7 total marks; the Overall line combines every subject.",
          TABLE_X,
          y,
          { width: TABLE_W }
        );
    }
  } else {
    // ── Full-phase matrix: rows = subjects; each test slot spans two
    // sub-columns (Obtained | Total). The phase header band and the "Test n"
    // label each span a full slot; the Obt/Tot leaf headers sit beneath them so
    // a parent can read marks scored and marks available for every test without
    // a combined cell.
    const table = buildSubjectTable(phases);
    const nSlots = table.columns.length;
    const cellOf = (subj, i) => table.columns[i].cellBySubject[subj] || null;

    if (nSlots === 0) {
      doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(CARD_BLACK)
        .text("No test results recorded for this period.", TABLE_X, y);
      y += 24;
    } else {
    // Font/column sizing: shrink rather than break the table when the session
    // has many phases/tests.
    const scoreFont = nSlots <= 8 ? 9 : nSlots <= 12 ? 8 : nSlots <= 16 ? 7 : 6;
    const headFont = Math.min(10, scoreFont + 1);
    const leafFont = Math.max(5, scoreFont - 1);
    const subjW = nSlots > 14 ? 88 : nSlots > 10 ? 104 : 122;
    const totalW = nSlots > 14 ? 44 : nSlots > 10 ? 50 : 56;
    const testW = (TABLE_W - subjW - totalW) / nSlots; // one slot (both sub-columns)
    const subW = testW / 2;
    const rowH = scoreFont + 9;
    const slotX = (i) => TABLE_X + subjW + i * testW; // left edge of slot i
    const obtX = (i) => slotX(i);
    const totX = (i) => slotX(i) + subW;
    const fmtObt = (t) => (t ? String(t.score) : CARD_DASH);
    const fmtTot = (t) => (t ? String(t.totalMarks) : CARD_DASH);

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
    const r3H = leafFont + 7; // single Obtained/Total leaf line
    const hdrH = r1H + r2H + r3H;

    const drawTableHeader = () => {
      const hy = y;
      strokeCardCell(TABLE_X, subjW, hy, hdrH, 0.75);
      doc.font("Helvetica-Bold").fontSize(headFont).fillColor(CARD_BLACK)
        .text("Subject", TABLE_X + 5, hy + hdrH / 2 - headFont * 0.6, { width: subjW - 10 });
      groupSpans.forEach((sp, k) => {
        const gx = slotX(sp.start);
        strokeCardCell(gx, sp.count * testW, hy, r1H, 0.75);
        drawCenteredLines(r1Lines[k], gx + 4, sp.count * testW - 8, hy, r1H, { font: "Helvetica-Bold", size: headFont });
      });
      strokeCardCell(slotX(nSlots), totalW, hy, hdrH, 0.75);
      drawCenteredLines(["Total"], slotX(nSlots) + 2, totalW - 4, hy, hdrH, { font: "Helvetica-Bold", size: headFont });
      table.columns.forEach((c, i) => {
        // "Test n" label spans the slot's two sub-columns.
        strokeCardCell(slotX(i), testW, hy + r1H, r2H, 0.5);
        drawCenteredLines(r2Lines[i], slotX(i) + 1, testW - 2, hy + r1H, r2H, { font: "Helvetica", size: r2Font });
        // Obtained / Total leaf headers.
        strokeCardCell(obtX(i), subW, hy + r1H + r2H, r3H, 0.5);
        drawCenteredLines(["Obt"], obtX(i) + 1, subW - 2, hy + r1H + r2H, r3H, { font: "Helvetica-Bold", size: leafFont });
        strokeCardCell(totX(i), subW, hy + r1H + r2H, r3H, 0.5);
        drawCenteredLines(["Tot"], totX(i) + 1, subW - 2, hy + r1H + r2H, r3H, { font: "Helvetica-Bold", size: leafFont });
      });
      y = hy + hdrH;
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
        doc.text(t, c.x + 3, ry + (rowH - scoreFont * 1.2) / 2, { width: c.w - 6, align: c.align });
      });
      cells.forEach((c) => strokeCardCell(c.x, c.w, ry, rowH, 0.5));
      y = ry + rowH;
    };

    drawTableHeader();

    const colObt = new Array(nSlots).fill(0);
    const colTot = new Array(nSlots).fill(0);
    const colHasScore = new Array(nSlots).fill(false);
    let grand = 0;

    table.subjects.forEach((subj) => {
      let subjSum = 0;
      const cells = [{ x: TABLE_X, w: subjW, text: String(subj), align: "left" }];
      for (let i = 0; i < nSlots; i++) {
        const t = cellOf(subj, i);
        cells.push({ x: obtX(i), w: subW, text: fmtObt(t), align: "center" });
        cells.push({ x: totX(i), w: subW, text: fmtTot(t), align: "center" });
        if (t) {
          subjSum += t.score;
          colObt[i] += t.score;
          colTot[i] += t.totalMarks;
          colHasScore[i] = true;
        }
      }
      grand += subjSum;
      cells.push({ x: slotX(nSlots), w: totalW, text: String(subjSum), align: "center" });
      drawRow(cells);
    });

    // Total row: per-slot obtained sums (+ slot max totals) + grand total.
    const totalCells = [{ x: TABLE_X, w: subjW, text: "Total", align: "left" }];
    for (let i = 0; i < nSlots; i++) {
      totalCells.push({ x: obtX(i), w: subW, text: colHasScore[i] ? String(colObt[i]) : CARD_DASH, align: "center" });
      totalCells.push({ x: totX(i), w: subW, text: colHasScore[i] ? String(colTot[i]) : CARD_DASH, align: "center" });
    }
    totalCells.push({ x: slotX(nSlots), w: totalW, text: String(grand), align: "center" });
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
          `Each test shows two columns: "Obt" (marks scored) and "Tot" (maximum marks). The Total column and the Obtained cells of the Total row sum marks scored; a dash means the subject has no test recorded in that slot.`,
        TABLE_X,
        y,
        { width: TABLE_W }
      );
    }
  }

  doc.end();

  return new Promise((resolve) => {
    doc.on("end", () => {
      const uuid = crypto.randomUUID();
      const filePath = path.join(PDF_DIR, `${uuid}.pdf`);
      fs.writeFileSync(filePath, Buffer.concat(buffers));
      const singleStudent = { name: student.name, whatsapp: student.whatsappNumber };
      resolve({ uuid, filePath, studentCount: 1, singleStudent, mode });
    });
  });
}

// ─── Public API ────────────────────────────────────────────────────────────────

exports.generateResultSheetPDF = async (testId, schoolName, filters) => {
  const data = await gatherResultSheet(testId);
  if (!data) throw new Error("Test not found");
  data.results = await narrowResultsByCategory(data.results, filters || {});
  // Pupils read the sheet best in roll-number order — natural numeric compare
  // ("2" before "10"), name as tie-breaker for missing rolls, mirroring the
  // roster listings.
  const rollKey = (r) => String((r.student && r.student.rollNumber) || "");
  const nameKey = (r) => String((r.student && r.student.name) || "");
  data.results.sort(
    (a, b) =>
      rollKey(a).localeCompare(rollKey(b), undefined, { numeric: true, sensitivity: "base" }) ||
      nameKey(a).localeCompare(nameKey(b), undefined, { numeric: true, sensitivity: "base" })
  );
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
exports.generateSessionReportBulkPDFs = async ({ sessionId, studentIds, phaseId, weekId, weekIds }, schoolName) => {
  const period = { phaseId, weekId, weekIds };
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

// Analytics mode helpers — exported for unit tests (mode detection, per-student
// sections, subject group aggregation and the percentage/N-A formatting).
exports._analyticsInternals = {
  detectAnalyticsMode,
  analyticsPercentLabel,
  groupRowsByStudent,
  buildSubjectWeekGroups,
  buildSubjectTestGroups,
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
