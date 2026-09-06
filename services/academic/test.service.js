const responseStatus = require("../../handlers/responseStatus.handler");
const Test = require("../../models/Academic/test.model");
const TestResult = require("../../models/Academic/testResult.model");
const TestSession = require("../../models/Academic/testSession.model");
const Subject = require("../../models/Academic/subject.model");
const ClassLevel = require("../../models/Academic/class.model");
const Student = require("../../models/Students/students.model");
const { getAssignedClassLevels } = require("./assignment.service");

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

  // Validate that the subject's appliesTo covers every classLevel in the test.
  // A test may target multiple classLevels at once; all must be valid for the subject.
  const subjectDoc = await Subject.findById(subject);
  if (!subjectDoc) return responseStatus(res, 404, "failed", "Subject not found");

  for (const clId of classLevels) {
    const classDoc = await ClassLevel.findById(clId);
    if (!classDoc) return responseStatus(res, 404, "failed", "Class not found");

    const applies = subjectDoc.appliesTo.some((a) => {
      // (1) specific: exact ClassLevel ID match
      if (a.classLevel) {
        return a.classLevel.toString() === classDoc._id.toString();
      }
      // (2) wholeGrade: gradeLevel matches the class's gradeLevel
      if (a.gradeLevel) {
        return a.gradeLevel === classDoc.gradeLevel;
      }
      return false;
    });

    if (!applies) {
      return responseStatus(
        res,
        400,
        "failed",
        `"${subjectDoc.name}" is not taught in "${classDoc.name}" (grade ${classDoc.gradeLevel}${classDoc.group ? ", " + classDoc.group : ""})`
      );
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

// Roster is scoped to only the sections this teacher is assigned to teach for
// the test's subject. On a multi-section test, a teacher assigned to one
// section must not see students from sections they don't teach.
exports.getTestRosterService = async (testId, teacherId, res) => {
  const test = await Test.findById(testId);
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  const assignedClassLevels = await getAssignedClassLevels(teacherId, test.subject, test.classLevels);
  if (assignedClassLevels.length === 0) {
    return responseStatus(res, 403, "failed", "You are not assigned to teach this subject for any class in this test");
  }

  const students = await Student.find({ classLevel: { $in: assignedClassLevels } }).select("name studentId classLevel");

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

  // Reject any score that is negative or exceeds the test's totalMarks.
  const invalidScores = records.filter(
    (r) => typeof r.score !== "number" || isNaN(r.score) || r.score < 0 || r.score > test.totalMarks
  );
  if (invalidScores.length > 0) {
    const details = invalidScores
      .map((r) => `student ${r.student}: ${r.score} (max ${test.totalMarks})`)
      .join("; ");
    return responseStatus(
      res,
      400,
      "failed",
      `Invalid score(s) — each score must be 0–${test.totalMarks}. ${details}`
    );
  }

  // Only sections this teacher is assigned to (for the test's subject) are in
  // scope. A teacher on one section of a multi-section test may not grade
  // students in sections they don't teach.
  const assignedClassLevels = await getAssignedClassLevels(teacherId, test.subject, test.classLevels);
  if (assignedClassLevels.length === 0) {
    return responseStatus(res, 403, "failed", "You are not assigned to teach this subject for any class in this test");
  }

  // Every submitted student must belong to one of the teacher's in-scope
  // sections. Reject the whole batch if any record is out of scope — hiding the
  // rows in the roster isn't enough; the write path must enforce it too.
  const submittedIds = records.map((r) => r.student);
  const inScope = await Student.find({
    _id: { $in: submittedIds },
    classLevel: { $in: assignedClassLevels },
  }).select("_id");
  const inScopeSet = new Set(inScope.map((s) => s._id.toString()));

  const outOfScope = records.filter((r) => !inScopeSet.has(String(r.student)));
  if (outOfScope.length > 0) {
    return responseStatus(res, 403, "failed", "You can only submit scores for students in the sections you are assigned to");
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

// ── Enhanced analytics: per-test stats, comparison, distribution ────────────
// Computes average, max, min, standard deviation for a selected test, scoped
// by class / student name / roll number / subject filters.  Also finds the
// most recent prior test for the same subject + class and returns the same
// stats for comparison.
exports.getEnhancedTestAnalyticsService = async (filters, res) => {
  const { testId, classLevelId, subjectId, nameSearch, rollNumberSearch } = filters;

  // ── Load filter-option dropdowns ──
  const testQuery = {};
  if (subjectId) testQuery.subject = subjectId;
  if (classLevelId) testQuery.classLevels = classLevelId;

  const [classes, subjects, tests] = await Promise.all([
    ClassLevel.find().sort({ gradeLevel: 1, group: 1, section: 1 }).lean(),
    Subject.find().sort("name").lean(),
    Test.find(testQuery)
      .populate("subject", "name")
      .populate("classLevels", "name")
      .sort({ date: -1 })
      .lean(),
  ]);

  // If no test selected, return just the dropdown data
  if (!testId) {
    return responseStatus(res, 200, "success", {
      classes, subjects, tests,
      current: null,
      previous: null,
      distribution: [],
      resultRows: [],
      resultCount: 0,
    });
  }

  const test = await Test.findById(testId)
    .populate("subject", "name")
    .populate("classLevels", "name");
  if (!test) {
    return responseStatus(res, 200, "success", {
      classes, subjects, tests,
      current: null, previous: null, distribution: [], resultCount: 0,
    });
  }

  // ── Build student filter pipeline ──
  const studentMatch = {};
  if (classLevelId) studentMatch.classLevel = classLevelId;
  if (nameSearch) studentMatch.name = { $regex: nameSearch, $options: "i" };
  if (rollNumberSearch) {
    const rn = Number(rollNumberSearch);
    if (!isNaN(rn)) studentMatch.rollNumber = rn;
    else studentMatch.rollNumber = { $regex: String(rollNumberSearch) };
  }

  // If subject filter is set, further restrict to students in classes that
  // offer this subject (only meaningful when no classLevel filter is set).
  // We'll apply subject filter on tests instead.

  // ── Fetch results for the current test ──
  let resultQuery = { test: testId };
  let results;

  if (Object.keys(studentMatch).length > 0) {
    // Two-step: find matching students first, then their results
    const matchingStudents = await Student.find(studentMatch).select("_id");
    const studentIds = matchingStudents.map((s) => s._id);
    if (studentIds.length === 0) {
      return responseStatus(res, 200, "success", {
        classes, subjects, tests,
        current: makeEmptyStats(test), previous: null, distribution: [], resultCount: 0,
      });
    }
    resultQuery.student = { $in: studentIds };
  }

  results = await TestResult.find(resultQuery)
    .populate("student", "name studentId rollNumber")
    .lean();

  // Populate student classLevel name for display
  const studentIds = results.map((r) => r.student._id);
  const studentsWithClass = await Student.find({ _id: { $in: studentIds } })
    .populate("classLevel", "name")
    .select("name studentId rollNumber classLevel")
    .lean();
  const studentClassMap = {};
  studentsWithClass.forEach((s) => {
    studentClassMap[String(s._id)] = s;
  });

  const scores = results.map((r) => r.score);
  const currentStats = computeStats(scores, test);

  // Attach student details to results for the table
  const resultRows = results.map((r) => {
    const s = studentClassMap[String(r.student._id)] || r.student;
    return {
      studentId: r.student._id,
      name: s.name,
      studentIdStr: s.studentId,
      rollNumber: s.rollNumber,
      className: s.classLevel ? s.classLevel.name : "—",
      score: r.score,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // ── Distribution (histogram buckets) ──
  const distribution = buildDistribution(scores, test.totalMarks);

  // ── Find previous test ──
  let previousStats = null;
  const testSubjectId = test.subject ? test.subject._id : test.subject;
  const testClassIds = (test.classLevels || []).map((cl) => String(cl._id));

  if (testSubjectId && testClassIds.length > 0) {
    const prevTest = await Test.findOne({
      _id: { $ne: testId },
      subject: testSubjectId,
      classLevels: { $in: testClassIds },
      date: { $lt: test.date },
    })
      .populate("subject", "name")
      .populate("classLevels", "name")
      .sort({ date: -1 });

    if (prevTest) {
      // Get results for previous test with same student filters
      let prevResultQuery = { test: prevTest._id };
      if (Object.keys(studentMatch).length > 0) {
        const matchingStudents = await Student.find(studentMatch).select("_id");
        const studentIds = matchingStudents.map((s) => s._id);
        if (studentIds.length > 0) prevResultQuery.student = { $in: studentIds };
        else prevResultQuery.student = { $in: [] }; // no match
      }
      const prevResults = await TestResult.find(prevResultQuery).lean();
      const prevScores = prevResults.map((r) => r.score);
      previousStats = computeStats(prevScores, prevTest);
      previousStats.testName = prevTest.name;
      previousStats.testDate = prevTest.date;
      previousStats.testId = prevTest._id;
    }
  }

  currentStats.testName = test.name;
  currentStats.testDate = test.date;
  currentStats.testId = test._id;

  return responseStatus(res, 200, "success", {
    classes, subjects, tests,
    current: currentStats,
    previous: previousStats,
    distribution,
    resultRows,
    resultCount: results.length,
    filters: { testId, classLevelId, subjectId, nameSearch, rollNumberSearch },
  });
};

// Helper: compute stats from an array of scores
function computeStats(scores, test) {
  if (!scores || scores.length === 0) {
    return { avg: null, max: null, min: null, stddev: null, count: 0, totalMarks: test ? test.totalMarks : null };
  }
  const n = scores.length;
  const sum = scores.reduce((a, b) => a + b, 0);
  const avg = Math.round((sum / n) * 100) / 100;
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const variance = scores.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / n;
  const stddev = Math.round(Math.sqrt(variance) * 100) / 100;

  return { avg, max, min, stddev, count: n, totalMarks: test.totalMarks };
}

function makeEmptyStats(test) {
  return { avg: null, max: null, min: null, stddev: null, count: 0, totalMarks: test.totalMarks, testName: test.name, testDate: test.date, testId: test._id };
}

// Helper: build histogram buckets for mark distribution
function buildDistribution(scores, totalMarks) {
  if (!scores || scores.length === 0) return [];
  // Create buckets: 0-10%, 10-20%, ..., 90-100% of totalMarks
  const bucketCount = 10;
  const bucketSize = totalMarks / bucketCount;
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = Math.round(i * bucketSize);
    const hi = Math.round((i + 1) * bucketSize);
    buckets.push({
      label: `${lo}–${hi}`,
      count: 0,
    });
  }
  scores.forEach((s) => {
    let idx = Math.floor((s / totalMarks) * bucketCount);
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    buckets[idx].count++;
  });
  return buckets;
}

// ── Exported for unit testing ────────────────────────────────────────────────
exports.computeStats = computeStats;
exports.buildDistribution = buildDistribution;

// ── Trend analytics: per-student or per-class score trend across tests ──────
// Mode A (student): one line per subject (or a single subject if filtered).
// Mode B (class):   class-average line (+ min/max band) for a subject.
exports.getTestTrendService = async (filters, res) => {
  const { mode, studentId, subjectId, classLevelId } = filters;

  // Shared dropdown data
  const [classes, subjects] = await Promise.all([
    ClassLevel.find().sort({ gradeLevel: 1, group: 1, section: 1 }).lean(),
    Subject.find().sort("name").lean(),
  ]);

  // Load students list for Mode A picker
  const studentQuery = {};
  if (classLevelId) studentQuery.classLevel = classLevelId;
  const students = await Student.find(studentQuery)
    .select("name studentId rollNumber classLevel")
    .populate("classLevel", "name")
    .sort("name")
    .lean();

  if (mode === "student") {
    if (!studentId) {
      return responseStatus(res, 200, "success", {
        mode: "student", classes, subjects, students, trend: [], tableRows: [],
      });
    }

    // Fetch all results for this student, populate test → subject + date
    const results = await TestResult.find({ student: studentId })
      .populate({
        path: "test",
        populate: [{ path: "subject", select: "name" }],
      })
      .lean();

    // Filter by subject if requested
    const filtered = results.filter((r) => {
      if (!r.test) return false;
      if (subjectId && r.test.subject && r.test.subject._id.toString() !== subjectId) return false;
      return true;
    });

    // Build chronological data points
    const points = filtered.map((r) => ({
      testName: r.test.name,
      date: r.test.date,
      score: r.score,
      totalMarks: r.test.totalMarks,
      percent: r.test.totalMarks
        ? Math.round((r.score / r.test.totalMarks) * 10000) / 100
        : null,
      subjectName: r.test.subject ? r.test.subject.name : "Unknown",
      subjectId: r.test.subject ? r.test.subject._id.toString() : null,
    }));

    points.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Group by subject for multi-line chart (when no subject filter)
    const bySubject = {};
    points.forEach((p) => {
      const key = p.subjectName;
      if (!bySubject[key]) bySubject[key] = [];
      bySubject[key].push(p);
    });

    const lines = Object.keys(bySubject).map((subj) => ({
      subject: subj,
      points: bySubject[subj],
    }));

    return responseStatus(res, 200, "success", {
      mode: "student", classes, subjects, students,
      trend: lines,
      tableRows: points,
    });
  }

  // Mode B — class average trend
  if (mode === "class") {
    if (!subjectId) {
      return responseStatus(res, 200, "success", {
        mode: "class", classes, subjects, students, trend: [], tableRows: [],
      });
    }

    // Find all tests for this subject, optionally scoped to a class
    const testQuery = { subject: subjectId };
    if (classLevelId) testQuery.classLevels = classLevelId;

    const tests = await Test.find(testQuery)
      .populate("subject", "name")
      .sort({ date: 1 })
      .lean();

    if (tests.length === 0) {
      return responseStatus(res, 200, "success", {
        mode: "class", classes, subjects, students, trend: [], tableRows: [],
      });
    }

    // For each test, compute class average/min/max percentage
    const trendPoints = [];
    for (const test of tests) {
      const results = await TestResult.find({ test: test._id }).lean();
      if (results.length === 0) continue;

      const percents = results
        .map((r) => test.totalMarks ? Math.round((r.score / test.totalMarks) * 10000) / 100 : null)
        .filter((p) => p !== null);

      if (percents.length === 0) continue;

      const avg = Math.round((percents.reduce((s, p) => s + p, 0) / percents.length) * 100) / 100;
      const min = Math.round(Math.min(...percents) * 100) / 100;
      const max = Math.round(Math.max(...percents) * 100) / 100;

      trendPoints.push({
        testName: test.name,
        date: test.date,
        avgPercent: avg,
        minPercent: min,
        maxPercent: max,
        count: percents.length,
      });
    }

    trendPoints.sort((a, b) => new Date(a.date) - new Date(b.date));

    return responseStatus(res, 200, "success", {
      mode: "class", classes, subjects, students,
      trend: trendPoints,
      tableRows: trendPoints,
    });
  }

  // No mode selected yet — just return dropdown data
  return responseStatus(res, 200, "success", {
    mode: null, classes, subjects, students, trend: [], tableRows: [],
  });
};

exports.deleteTestService = async (testId, res) => {
  const test = await Test.findById(testId);
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  // Cascade: remove all TestResult documents tied to this test, then the test itself.
  const deletedResults = await TestResult.deleteMany({ test: testId });
  await Test.deleteOne({ _id: testId });

  return responseStatus(res, 200, "success", {
    test: test.name,
    deletedResults: deletedResults.deletedCount,
  });
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
