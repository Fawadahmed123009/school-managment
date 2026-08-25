const responseStatus = require("../../handlers/responseStatus.handler");
const Test = require("../../models/Academic/test.model");
const TestResult = require("../../models/Academic/testResult.model");
const TestSession = require("../../models/Academic/testSession.model");
const Student = require("../../models/Students/students.model");
const { isTeacherAssigned } = require("./assignment.service");

exports.createTestService = async (data, adminId, res) => {
  const { name, subject, classLevels, date, totalMarks, passMarks, session, phase } = data;

  if (!classLevels || classLevels.length === 0) {
    return responseStatus(res, 400, "failed", "A test needs at least one class");
  }

  if (session) {
    const sessionDoc = await TestSession.findById(session);
    if (!sessionDoc) return responseStatus(res, 404, "failed", "Session not found");
    if (phase) {
      const phaseExists = sessionDoc.phases.some((p) => p._id.toString() === phase);
      if (!phaseExists) return responseStatus(res, 400, "failed", "Phase not found in this session");
    }
  }

  const test = await Test.create({
    name,
    subject,
    classLevels,
    date,
    totalMarks,
    passMarks,
    session: session || null,
    phase: phase || null,
    createdBy: adminId,
  });

  return responseStatus(res, 201, "success", test);
};

exports.getAllTestsService = async (res) => {
  const tests = await Test.find({})
    .populate("subject", "name")
    .populate("classLevels", "name")
    .populate("session", "name")
    .sort({ date: -1 });
  return responseStatus(res, 200, "success", tests);
};

// Teacher-scoped variant: returns only tests whose subject + at least one
// classLevel match an Assignment record for this teacher.
exports.getTeacherScopedTestsService = async (teacherId, res) => {
  const Assignment = require("../../models/Academic/assignment.model");

  const assignments = await Assignment.find({ teacher: teacherId }).select(
    "subject classLevel"
  );

  if (assignments.length === 0) {
    return responseStatus(res, 200, "success", []);
  }

  // Build a map of subjectId → Set<classLevelId>
  const subjectClassMap = {};
  assignments.forEach((a) => {
    const subId = a.subject.toString();
    if (!subjectClassMap[subId]) subjectClassMap[subId] = new Set();
    subjectClassMap[subId].add(a.classLevel.toString());
  });

  // Fetch all tests for the teacher's assigned subjects
  const subjectIds = Object.keys(subjectClassMap);
  const tests = await Test.find({ subject: { $in: subjectIds } })
    .populate("subject", "name")
    .populate("classLevels", "name")
    .populate("session", "name")
    .sort({ date: -1 });

  // Keep only tests where the teacher covers at least one of the test's classes
  const filtered = tests.filter((t) => {
    const subId = t.subject._id.toString();
    const classSet = subjectClassMap[subId];
    return t.classLevels.some((cl) => classSet.has(cl._id.toString()));
  });

  return responseStatus(res, 200, "success", filtered);
};

// Unified roster across every class the test covers.
// Teacher must be assigned to this subject for at least one of the test's classes.
exports.getTestRosterService = async (testId, teacherId, res) => {
  const test = await Test.findById(testId);
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  let assignedToAtLeastOne = false;
  for (const classId of test.classLevels) {
    if (await isTeacherAssigned(teacherId, test.subject, classId)) {
      assignedToAtLeastOne = true;
      break;
    }
  }
  if (!assignedToAtLeastOne) {
    return responseStatus(res, 403, "failed", "You are not assigned to teach this subject for any class in this test");
  }

  const students = await Student.find({ classLevel: { $in: test.classLevels } }).select("name studentId classLevel");

  const existing = await TestResult.find({ test: testId });
  const existingMap = {};
  existing.forEach((r) => { existingMap[r.student.toString()] = r.score; });

  const roster = students.map((s) => ({
    student: s._id,
    name: s.name,
    studentId: s.studentId,
    score: existingMap[s._id.toString()] ?? null,
  }));

  return responseStatus(res, 200, "success", { test, roster });
};

exports.submitTestResultsService = async (testId, records, teacherId, res) => {
  if (!Array.isArray(records) || records.length === 0) {
    return responseStatus(res, 400, "failed", "No results provided");
  }

  const test = await Test.findById(testId);
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  let assignedToAtLeastOne = false;
  for (const classId of test.classLevels) {
    if (await isTeacherAssigned(teacherId, test.subject, classId)) {
      assignedToAtLeastOne = true;
      break;
    }
  }
  if (!assignedToAtLeastOne) {
    return responseStatus(res, 403, "failed", "You are not assigned to teach this subject for any class in this test");
  }

  const results = [];
  for (const r of records) {
    const updated = await TestResult.findOneAndUpdate(
      { test: testId, student: r.student },
      { test: testId, student: r.student, score: r.score, markedBy: teacherId },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    results.push(updated);
  }

  return responseStatus(res, 201, "success", results);
};

exports.getTestResultSheetService = async (testId, res) => {
  const test = await Test.findById(testId)
    .populate("subject", "name")
    .populate("classLevels", "name");
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  const results = await TestResult.find({ test: testId }).populate("student", "name studentId");

  return responseStatus(res, 200, "success", { test, results });
};

exports.getTestAnalyticsService = async (filters, res) => {
  const { studentId, subjectId, fromDate, toDate } = filters;

  const testQuery = {};
  if (subjectId) testQuery.subject = subjectId;
  if (fromDate || toDate) {
    testQuery.date = {};
    if (fromDate) testQuery.date.$gte = new Date(fromDate);
    if (toDate) testQuery.date.$lte = new Date(toDate);
  }

  const tests = await Test.find(testQuery).populate("subject", "name");
  const testIds = tests.map((t) => t._id);

  const resultQuery = { test: { $in: testIds } };
  if (studentId) resultQuery.student = studentId;

  const results = await TestResult.find(resultQuery)
    .populate("student", "name studentId")
    .populate({ path: "test", populate: { path: "subject", select: "name" } });

  const summary = results.map((r) => ({
    student: r.student,
    test: r.test.name,
    subject: r.test.subject ? r.test.subject.name : "Unknown",
    date: r.test.date,
    score: r.score,
    totalMarks: r.test.totalMarks,
    percent: Math.round((r.score / r.test.totalMarks) * 10000) / 100,
  }));

  return responseStatus(res, 200, "success", summary);
};

// Session report card for one student: results grouped by phase.
// Overall session-level rollup formula is intentionally left as a simple
// average-of-phase-averages for now — flagged as provisional, confirm
// with the client once real multi-phase data exists to validate against.
exports.getSessionReportCardService = async (sessionId, studentId, res) => {
  const TestSession = require("../../models/Academic/testSession.model");
  const Test = require("../../models/Academic/test.model");
  const TestResult = require("../../models/Academic/testResult.model");

  const session = await TestSession.findById(sessionId);
  if (!session) return responseStatus(res, 404, "failed", "Session not found");

  const tests = await Test.find({ session: sessionId }).populate("subject", "name");
  const testIds = tests.map((t) => t._id);

  const results = await TestResult.find({ test: { $in: testIds }, student: studentId });
  const resultByTest = {};
  results.forEach((r) => { resultByTest[r.test.toString()] = r.score; });

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

      const phaseAverage = rows.length > 0
        ? Math.round((rows.reduce((sum, r) => sum + r.percent, 0) / rows.length) * 100) / 100
        : null;

      return {
        phase: phase.name,
        order: phase.order,
        tests: rows,
        average: phaseAverage,
      };
    });

  const phasesWithScores = phaseBlocks.filter((p) => p.average !== null);
  const overallAverage = phasesWithScores.length > 0
    ? Math.round((phasesWithScores.reduce((sum, p) => sum + p.average, 0) / phasesWithScores.length) * 100) / 100
    : null;

  return responseStatus(res, 200, "success", {
    session: { _id: session._id, name: session.name },
    phases: phaseBlocks,
    overallAverage,
    overallAverageNote: "Provisional formula: simple average of phase averages. Confirm with client.",
  });
};
