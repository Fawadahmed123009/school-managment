const mongoose = require("mongoose");
const responseStatus = require("../../handlers/responseStatus.handler");
const Test = require("../../models/Academic/test.model");
const TestResult = require("../../models/Academic/testResult.model");
const TestSession = require("../../models/Academic/testSession.model");
const Subject = require("../../models/Academic/subject.model");
const ClassLevel = require("../../models/Academic/class.model");
const Student = require("../../models/Students/students.model");
const Assignment = require("../../models/Academic/assignment.model");
const TeacherDoc = require("../../models/Staff/teachers.model");
const { getAssignedClassLevels } = require("./assignment.service");

exports.createTestService = async (data, adminId, res) => {
  const { name, subject, classLevels, date, totalMarks, passMarks, session, phase, week } = data;

  if (!classLevels || classLevels.length === 0) {
    return responseStatus(res, 400, "failed", "A test needs at least one class");
  }

  if (session) {
    const sessionDoc = await TestSession.findById(session);
    if (!sessionDoc) return responseStatus(res, 404, "failed", "Session not found");
    if (phase) {
      const phaseExists = sessionDoc.phases.some((p) => p._id.toString() === phase);
      if (!phaseExists) return responseStatus(res, 400, "failed", "Phase not found in this session");

      // Week is required when both session and phase are set
      if (!week) {
        return responseStatus(res, 400, "failed", "A week is required for session-based tests — select a week for this phase");
      }

      // Validate that the selected week belongs to this session+phase
      const Week = require("../../models/Academic/week.model");
      const weekDoc = await Week.findById(week);
      if (!weekDoc || weekDoc.session.toString() !== session || weekDoc.phase.toString() !== phase) {
        return responseStatus(res, 400, "failed", "The selected week does not belong to this session's phase");
      }
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
    week,
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
    .populate("week", "name startDate endDate")
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
    .populate("week", "name startDate endDate")
    .sort({ date: -1 });

  // Keep only tests where the teacher covers at least one of the test's classes
  const filtered = tests.filter((t) => {
    const subId = t.subject._id.toString();
    const classSet = subjectClassMap[subId];
    return t.classLevels.some((cl) => classSet.has(cl._id.toString()));
  });

  return responseStatus(res, 200, "success", filtered);
};

// ── Cascade API services ─────────────────────────────────────────────────────
// These support the three-level Class → Subject → Test dropdown cascade
// for teacher test-marking views.

/**
 * Level 1: Get distinct classes the teacher is assigned to.
 * Returns classLevel documents with _id and name.
 */
exports.getTeacherAssignedClassesService = async (teacherId, res) => {
  const Assignment = require("../../models/Academic/assignment.model");

  const assignments = await Assignment.find({ teacher: teacherId })
    .distinct("classLevel");

  if (assignments.length === 0) {
    return responseStatus(res, 200, "success", []);
  }

  const classes = await ClassLevel.find({ _id: { $in: assignments } })
    .select("_id name gradeLevel group")
    .sort("name");

  return responseStatus(res, 200, "success", classes);
};

/**
 * Level 2: Get distinct subjects the teacher is assigned to teach
 * across one or more classes (union). Accepts a comma-separated string
 * of classLevel IDs or a single ID. Returns each subject annotated with
 * the class IDs it applies to.
 *
 * Security: validates that the teacher is actually assigned to EVERY
 * requested classLevel before returning results.
 */
exports.getTeacherAssignedSubjectsService = async (teacherId, classLevelParam, res) => {
  const Assignment = require("../../models/Academic/assignment.model");

  if (!classLevelParam) {
    return responseStatus(res, 400, "failed", "classLevel is required");
  }

  // Normalise to array of trimmed, non-empty IDs
  const classLevelIds = (typeof classLevelParam === "string" ? classLevelParam.split(",") : [classLevelParam])
    .map((s) => String(s).trim())
    .filter(Boolean);

  if (classLevelIds.length === 0) {
    return responseStatus(res, 400, "failed", "classLevel is required");
  }

  // Security: verify teacher is actually assigned to ALL requested classLevels
  // Use distinct() to count unique classes, not assignment documents.
  // countDocuments would be wrong: a teacher with 2 subjects for 4 classes
  // yields 8 docs but only covers 4 classes — must reject, not pass.
  const assignedClassLevels = await Assignment.distinct("classLevel", {
    teacher: teacherId,
    classLevel: { $in: classLevelIds },
  });

  if (assignedClassLevels.length < classLevelIds.length) {
    return responseStatus(res, 403, "failed", "You are not assigned to one or more of the selected classes");
  }

  // Get all assignments across the selected classes
  const assignments = await Assignment.find({
    teacher: teacherId,
    classLevel: { $in: classLevelIds },
  }).select("subject classLevel").lean();

  if (assignments.length === 0) {
    return responseStatus(res, 200, "success", []);
  }

  // Group subject → set of classLevel IDs
  const subjectClassMap = {};
  assignments.forEach((a) => {
    const subId = a.subject.toString();
    if (!subjectClassMap[subId]) subjectClassMap[subId] = new Set();
    subjectClassMap[subId].add(a.classLevel.toString());
  });

  const subjectIds = Object.keys(subjectClassMap);
  const subjects = await Subject.find({ _id: { $in: subjectIds } })
    .select("_id name")
    .sort("name");

  // Build response with class-level annotations
  const result = subjects.map((s) => ({
    _id: s._id,
    name: s.name,
    classLevels: Array.from(subjectClassMap[s._id.toString()]),
  }));

  return responseStatus(res, 200, "success", result);
};

/**
 * Level 3: Get tests matching the selected subject AND covering at least
 * one of the selected classes. Accepts a comma-separated string of
 * classLevel IDs or a single ID.
 *
 * Security: validates that the teacher is actually assigned to this
 * subject for at least one of the selected classes.
 */
exports.getTeacherScopedTestsByClassSubjectService = async (teacherId, classLevelParam, subjectId, sessionParam, phaseParam, weekParam, res) => {
  const Assignment = require("../../models/Academic/assignment.model");

  if (!classLevelParam || !subjectId) {
    return responseStatus(res, 400, "failed", "Both classLevel and subject are required");
  }

  // Normalise to array of trimmed, non-empty IDs
  const classLevelIds = (typeof classLevelParam === "string" ? classLevelParam.split(",") : [classLevelParam])
    .map((s) => String(s).trim())
    .filter(Boolean);

  if (classLevelIds.length === 0) {
    return responseStatus(res, 400, "failed", "Both classLevel and subject are required");
  }

  // Security: verify teacher is assigned to this subject for at least one selected class
  const teacherAssigned = await Assignment.findOne({
    teacher: teacherId,
    classLevel: { $in: classLevelIds },
    subject: subjectId,
  });

  if (!teacherAssigned) {
    return responseStatus(res, 403, "failed", "You are not assigned to teach this subject for any of the selected classes");
  }

  // Build query with optional session/phase/week filters
  const query = {
    subject: subjectId,
    classLevels: { $in: classLevelIds },
  };

  if (sessionParam) {
    if (sessionParam === "none") {
      query.session = null;
    } else {
      query.session = sessionParam;
    }
  }
  if (phaseParam) {
    if (phaseParam === "none") {
      query.phase = null;
    } else {
      query.phase = phaseParam;
    }
  }
  if (weekParam) {
    if (weekParam === "none") {
      query.week = null;
    } else {
      query.week = weekParam;
    }
  }

  const tests = await Test.find(query)
    .populate("subject", "name")
    .populate("classLevels", "name")
    .populate("session", "name")
    .populate("week", "name startDate endDate")
    .sort({ date: -1 });

  return responseStatus(res, 200, "success", tests);
};

// ── Cascade session/phase/week services ───────────────────────────────────────
// These support the step-down filters (Session → Phase → Week) between the
// Subject dropdown and the Test dropdown on both the teacher mark-entry and
// OCR marks-entry pages.

/**
 * Cascade Level 3: Get distinct sessions that have tests for the selected
 * class+subject. Returns session docs annotated with their phases.
 */
exports.getTeacherCascadeSessionsService = async (teacherId, classLevelParam, subjectId, res) => {
  const Assignment = require("../../models/Academic/assignment.model");

  if (!classLevelParam || !subjectId) {
    return responseStatus(res, 400, "failed", "Both classLevel and subject are required");
  }

  const classLevelIds = (typeof classLevelParam === "string" ? classLevelParam.split(",") : [classLevelParam])
    .map((s) => String(s).trim())
    .filter(Boolean);

  // Security: verify teacher is assigned to this subject for at least one selected class
  const teacherAssigned = await Assignment.findOne({
    teacher: teacherId,
    classLevel: { $in: classLevelIds },
    subject: subjectId,
  });

  if (!teacherAssigned) {
    return responseStatus(res, 403, "failed", "You are not assigned to teach this subject for any of the selected classes");
  }

  // Find distinct session IDs from tests matching class+subject
  const sessionIds = await Test.distinct("session", {
    subject: subjectId,
    classLevels: { $in: classLevelIds },
    session: { $ne: null },
  });

  // Check if there are tests without a session
  const unassignedCount = await Test.countDocuments({
    subject: subjectId,
    classLevels: { $in: classLevelIds },
    session: null,
  });

  let sessions = [];
  if (sessionIds.length > 0) {
    sessions = await TestSession.find({ _id: { $in: sessionIds } })
      .select("name phases")
      .sort("name");
  }

  return responseStatus(res, 200, "success", {
    sessions,
    hasUnassigned: unassignedCount > 0,
  });
};

/**
 * Cascade Level 4: Get distinct phases from a session that have tests for
 * the selected class+subject. Phases are subdocuments of TestSession.
 */
exports.getTeacherCascadePhasesService = async (teacherId, classLevelParam, subjectId, sessionId, res) => {
  const Assignment = require("../../models/Academic/assignment.model");

  if (!classLevelParam || !subjectId || !sessionId) {
    return responseStatus(res, 400, "failed", "classLevel, subject, and session are required");
  }

  const classLevelIds = (typeof classLevelParam === "string" ? classLevelParam.split(",") : [classLevelParam])
    .map((s) => String(s).trim())
    .filter(Boolean);

  // Security check
  const teacherAssigned = await Assignment.findOne({
    teacher: teacherId,
    classLevel: { $in: classLevelIds },
    subject: subjectId,
  });

  if (!teacherAssigned) {
    return responseStatus(res, 403, "failed", "You are not assigned to teach this subject for any of the selected classes");
  }

  // Find distinct phase IDs from tests matching class+subject+session
  const phaseIds = await Test.distinct("phase", {
    subject: subjectId,
    classLevels: { $in: classLevelIds },
    session: sessionId,
    phase: { $ne: null },
  });

  // Check if there are tests without a phase in this session
  const unassignedCount = await Test.countDocuments({
    subject: subjectId,
    classLevels: { $in: classLevelIds },
    session: sessionId,
    phase: null,
  });

  // Get phase details from the session document
  const session = await TestSession.findById(sessionId);
  let phases = [];
  if (session && phaseIds.length > 0) {
    phases = session.phases
      .filter((p) => phaseIds.some((id) => id.toString() === p._id.toString()))
      .sort((a, b) => a.order - b.order);
  }

  return responseStatus(res, 200, "success", {
    phases,
    hasUnassigned: unassignedCount > 0,
  });
};

/**
 * Cascade Level 5: Get weeks for a session+phase that have tests for the
 * selected class+subject.
 */
exports.getTeacherCascadeWeeksService = async (teacherId, classLevelParam, subjectId, sessionId, phaseId, res) => {
  const Assignment = require("../../models/Academic/assignment.model");
  const Week = require("../../models/Academic/week.model");

  if (!classLevelParam || !subjectId || !sessionId || !phaseId) {
    return responseStatus(res, 400, "failed", "classLevel, subject, session, and phase are required");
  }

  const classLevelIds = (typeof classLevelParam === "string" ? classLevelParam.split(",") : [classLevelParam])
    .map((s) => String(s).trim())
    .filter(Boolean);

  // Security check
  const teacherAssigned = await Assignment.findOne({
    teacher: teacherId,
    classLevel: { $in: classLevelIds },
    subject: subjectId,
  });

  if (!teacherAssigned) {
    return responseStatus(res, 403, "failed", "You are not assigned to teach this subject for any of the selected classes");
  }

  // Find distinct week IDs from tests matching class+subject+session+phase
  const weekIds = await Test.distinct("week", {
    subject: subjectId,
    classLevels: { $in: classLevelIds },
    session: sessionId,
    phase: phaseId,
    week: { $ne: null },
  });

  // Check if there are tests without a week
  const unassignedCount = await Test.countDocuments({
    subject: subjectId,
    classLevels: { $in: classLevelIds },
    session: sessionId,
    phase: phaseId,
    week: null,
  });

  let weeks = [];
  if (weekIds.length > 0) {
    weeks = await Week.find({ _id: { $in: weekIds } })
      .select("name startDate endDate")
      .sort("startDate");
  }

  return responseStatus(res, 200, "success", {
    weeks,
    hasUnassigned: unassignedCount > 0,
  });
};

// Roster is scoped to only the sections this teacher is assigned to teach for
// the test's subject. On a multi-section test, a teacher assigned to one
// section must not see students from sections they don't teach.
exports.getTestRosterService = async (testId, teacherId, res) => {
  const test = await Test.findById(testId).populate("week", "name startDate endDate");
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  const assignedClassLevels = await getAssignedClassLevels(teacherId, test.subject, test.classLevels);
  if (assignedClassLevels.length === 0) {
    return responseStatus(res, 403, "failed", "You are not assigned to teach this subject for any class in this test");
  }

  const students = await Student.find({ classLevel: { $in: assignedClassLevels } })
    .select("name studentId rollNumber classLevel fatherName parent")
    .populate("parent", "name");

  // Marks timeline: updatedAt is when the teacher last saved/edited the score,
  // createdAt is the original upload — both surface in the roster UI and audit.
  const existing = await TestResult.find({ test: testId }).populate("markedBy", "name").lean();
  const existingMap = {};
  existing.forEach((r) => {
    existingMap[r.student.toString()] = {
      score: r.score,
      markedAt: r.updatedAt || r.createdAt || null,
      firstMarkedAt: r.createdAt || null,
      markedByName: r.markedBy && r.markedBy.name ? r.markedBy.name : null,
    };
  });

  const roster = students.map((s) => {
    const prev = existingMap[s._id.toString()];
    return {
      student: s._id,
      name: s.name,
      studentId: s.studentId,
      rollNumber: s.rollNumber || '',
      // Parent name shown alongside the student while entering marks — the
      // linked Parent record when present, otherwise the student's fatherName.
      parentName: (s.parent && s.parent.name) || s.fatherName || '',
      score: prev ? prev.score : null,
      markedAt: prev ? prev.markedAt : null,
      firstMarkedAt: prev ? prev.firstMarkedAt : null,
      markedByName: prev ? prev.markedByName : null,
    };
  });

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

/**
 * Admin marks audit — one row per test with score statistics AND the marking
 * timeline: when marks were first uploaded (earliest TestResult createdAt),
 * when they were last changed (latest updatedAt) and which teacher entered
 * them. A stored score of 0 is treated as an absence: it is counted in
 * `absentCount` but excluded from the avg / min / max stats. Tests with no
 * results yet are included (markedCount 0) so the admin
 * can also see what is still unmarked. Optional filters: `search` (test /
 * subject / class) and `teacher` — a marker's id or name, keeping only the
 * tests that teacher marked. Read-only, admin/manager only.
 */
exports.getMarksAuditService = async (query, res) => {
  const { search, teacher } = query || {};

  const tests = await Test.find({})
    .populate("subject", "name")
    .populate("classLevels", "name gradeLevel group")
    .sort({ date: -1 })
    .lean();

  // Group every TestResult by test to derive per-test stats + timeline.
  const results = await TestResult.find({})
    .select("test score createdAt updatedAt markedBy")
    .populate("markedBy", "name")
    .lean();
  const byTest = {};
  results.forEach((r) => {
    const key = String(r.test);
    (byTest[key] = byTest[key] || []).push(r);
  });

  // Resolve which teacher(s) are responsible for marking each test so an
  // overdue one can be nudged over WhatsApp: assignment is (subject +
  // classLevel) → teacher. A test spanning several classes may map to several
  // teachers; we surface each one's name + saved WhatsApp number.
  const asRefId = (ref) => (ref && ref._id ? String(ref._id) : ref ? String(ref) : null);
  const [assignments, teachers] = await Promise.all([
    Assignment.find().select("teacher subject classLevel").lean(),
    TeacherDoc.find().select("name whatsappNumber").lean(),
  ]);
  const teacherInfo = {};
  teachers.forEach((t) => {
    teacherInfo[String(t._id)] = { name: t.name || "", whatsapp: t.whatsappNumber || "" };
  });
  const teacherIdsBySubjectClass = {}; // `subjectId|classLevelId` → Set(teacherId)
  assignments.forEach((a) => {
    const sid = asRefId(a.subject);
    const cid = asRefId(a.classLevel);
    const tid = asRefId(a.teacher);
    if (!sid || !cid || !tid) return;
    const key = `${sid}|${cid}`;
    (teacherIdsBySubjectClass[key] || (teacherIdsBySubjectClass[key] = new Set())).add(tid);
  });

  // A test older than this many days (by its own date) is flagged overdue.
  const OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();

  const round2 = (n) => Math.round(n * 100) / 100;

  let rows = tests.map((t) => {
    const rs = byTest[String(t._id)] || [];
    const scores = rs.map((r) => r.score).filter((s) => typeof s === "number" && !isNaN(s));
    // A stored 0 means the student was absent (0-mark entries are how absences
    // are recorded), so absences are counted separately and EXCLUDED from the
    // score/percentage stats below — otherwise they unfairly drag the average
    // and min down. markedCount / passCount keep counting over all entries
    // (a 0 can never reach a positive pass mark, so passCount is unaffected).
    const absentCount = scores.filter((s) => s === 0).length;
    const present = scores.filter((s) => s > 0);
    // Percentages are computed against the test's CURRENT totalMarks; if the
    // scale was lowered after marking, a stored score may exceed it — those
    // rows are excluded from percent stats rather than reported >100%.
    const percents = t.totalMarks
      ? present.filter((s) => s <= t.totalMarks).map((s) => round2((s / t.totalMarks) * 100))
      : [];

    const stat = (arr, fn) => (arr.length ? round2(fn(arr)) : null);
    const times = (field) => rs.map((r) => (r[field] ? new Date(r[field]).getTime() : null)).filter(Boolean);
    const created = times("createdAt");
    const updated = times("updatedAt");

    // Who last touched the marks: the teacher on the most recently updated row.
    let lastUpdatedBy = null;
    if (updated.length) {
      const lastAt = Math.max(...updated);
      const lastRow = rs.find((r) => r.updatedAt && new Date(r.updatedAt).getTime() === lastAt);
      lastUpdatedBy = lastRow && lastRow.markedBy ? lastRow.markedBy.name : null;
    }
    const teacherNames = [...new Set(rs.map((r) => (r.markedBy ? r.markedBy.name : null)).filter(Boolean))];
    // Marker id→name pairs — the audit page's teacher-filter dropdown filters
    // by id (names can collide), so each row carries its marker ids too.
    const markerMap = new Map();
    rs.forEach((r) => {
      if (r.markedBy && r.markedBy._id) markerMap.set(String(r.markedBy._id), r.markedBy.name || "");
    });

    // Overdue = the test date is more than 3 days in the past. Marking status
    // is intentionally not part of the flag — admin sees it from the Marked
    // column (0 / not marked = still outstanding).
    const testTime = t.date ? new Date(t.date).getTime() : null;
    const overdue = testTime != null && nowMs - testTime > OVERDUE_MS;

    // Teachers responsible for marking (via subject+class assignments), deduped
    // by id and sorted by name so reminder buttons are stable.
    const reminderSet = new Set();
    if (t.subject && t.subject._id) {
      const sid = String(t.subject._id);
      (t.classLevels || []).forEach((c) => {
        const cid = asRefId(c);
        if (!cid) return;
        (teacherIdsBySubjectClass[`${sid}|${cid}`] || new Set()).forEach((tid) => reminderSet.add(tid));
      });
    }
    // If assignment data is missing, fall back to whoever has marked so far.
    if (reminderSet.size === 0) markerMap.forEach((_name, id) => reminderSet.add(id));
    const reminderTeachers = [...reminderSet]
      .map((id) => teacherInfo[id] || { name: "", whatsapp: "" })
      .filter((ti) => ti.name || ti.whatsapp)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    return {
      testId: t._id,
      name: t.name,
      subject: t.subject ? t.subject.name : "",
      classes: (t.classLevels || []).map((c) => c.name).join(", "),
      totalMarks: t.totalMarks,
      passMarks: t.passMarks,
      testDate: t.date,
      markedCount: rs.length,
      // Stats are over present (non-zero) scores only — see absentCount note.
      avgScore: stat(present, (a) => a.reduce((x, y) => x + y, 0) / a.length),
      minScore: stat(present, (a) => Math.min(...a)),
      maxScore: stat(present, (a) => Math.max(...a)),
      avgPercent: stat(percents, (a) => a.reduce((x, y) => x + y, 0) / a.length),
      minPercent: stat(percents, (a) => Math.min(...a)),
      maxPercent: stat(percents, (a) => Math.max(...a)),
      passCount: t.passMarks != null ? scores.filter((s) => s >= t.passMarks).length : null,
      absentCount,
      overdue,
      firstUploadAt: created.length ? new Date(Math.min(...created)) : null,
      lastUploadAt: created.length ? new Date(Math.max(...created)) : null,
      lastUpdateAt: updated.length ? new Date(Math.max(...updated)) : null,
      lastUpdatedBy,
      teachers: teacherNames,
      markers: [...markerMap.entries()].map(([id, name]) => ({ id, name })),
      reminderTeachers,
    };
  });

  if (search && String(search).trim()) {
    const q = String(search).trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.subject.toLowerCase().includes(q) ||
        r.classes.toLowerCase().includes(q)
    );
  }

  // Teacher filter: exact match on the marker's id OR name (the dropdown
  // submits ids; name queries make the API usable directly). Tests the
  // teacher never marked — including unmarked ones — are excluded.
  if (teacher && String(teacher).trim()) {
    const tq = String(teacher).trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.markers.some((m) => m.id.toLowerCase() === tq || (m.name || "").toLowerCase() === tq)
    );
  }

  // Most-recently-touched first; unmarked tests fall back to the test date.
  rows.sort((a, b) => {
    const at = a.lastUpdateAt ? new Date(a.lastUpdateAt).getTime() : new Date(a.testDate).getTime();
    const bt = b.lastUpdateAt ? new Date(b.lastUpdateAt).getTime() : new Date(b.testDate).getTime();
    return bt - at;
  });

  return responseStatus(res, 200, "success", rows);
};

/**
 * Read a test's score scale (total/pass marks) so the mark-entry UIs can show
 * editable fields without shipping the whole roster. Shares the same access
 * gate as the marks update (assigned teacher or manager).
 */
exports.getTestMarksService = async (testId, res) => {
  const test = await Test.findById(testId).select("name totalMarks passMarks");
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  return responseStatus(res, 200, "success", {
    _id: test._id,
    name: test.name,
    totalMarks: test.totalMarks,
    passMarks: test.passMarks,
  });
};

/**
 * Update a test's total marks / pass marks (from the mark-entry page).
 * Only the two score-scale fields are mutable here — never the identity,
 * subject or class scope of the test.
 *
 * Validation:
 *   • totalMarks must be a number ≥ 1, passMarks a number ≥ 0 (same rules as creation)
 *   • passMarks must not exceed totalMarks
 *   • if the new total is BELOW totalMarks, every already-entered score must
 *     still fit the new scale — otherwise the stored results would be invalid.
 */
exports.updateTestMarksService = async (testId, data, res) => {
  const totalMarks = Number(data.totalMarks);
  const passMarks = Number(data.passMarks);

  if (!Number.isFinite(totalMarks) || totalMarks < 1) {
    return responseStatus(res, 400, "failed", "Total marks must be a number of at least 1");
  }
  if (!Number.isFinite(passMarks) || passMarks < 0) {
    return responseStatus(res, 400, "failed", "Pass marks must be a number of 0 or more");
  }
  if (passMarks > totalMarks) {
    return responseStatus(res, 400, "failed", "Pass marks cannot exceed total marks");
  }

  const test = await Test.findById(testId);
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  // Shrinking the scale must not orphan scores above the new maximum.
  if (totalMarks !== test.totalMarks) {
    const tooHigh = await TestResult.find({ test: testId, score: { $gt: totalMarks } }).populate("student", "name");
    if (tooHigh.length > 0) {
      const details = tooHigh
        .slice(0, 5)
        .map((r) => `${r.score}${r.student?.name ? " (" + r.student.name + ")" : ""}`)
        .join(", ");
      return responseStatus(
        res,
        400,
        "failed",
        `Cannot lower total marks below ${totalMarks} — ${tooHigh.length} entered score(s) exceed it (${details}${tooHigh.length > 5 ? ", …" : ""}). Remove or correct those scores first.`
      );
    }
  }

  test.totalMarks = totalMarks;
  test.passMarks = passMarks;
  await test.save();

  return responseStatus(res, 200, "success", test);
};

exports.getTestResultSheetService = async (testId, res) => {
  const test = await Test.findById(testId)
    .populate("subject", "name")
    .populate("classLevels", "name")
    .populate("week", "name startDate endDate");
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
    // D-2: guard the percent division — legacy tests with totalMarks 0 would
    // otherwise yield NaN%/Infinity%. Same pattern used across this codebase.
    percent: r.test.totalMarks ? Math.round((r.score / r.test.totalMarks) * 10000) / 100 : null,
  }));

  return responseStatus(res, 200, "success", summary);
};

// ── Admin class-filter resolver ─────────────────────────────────────────────
// Resolves a comma-separated list of class tokens — each either a ClassLevel
// id or a whole grade as "grade:<level>" (e.g. "grade:9") — into distinct
// ClassLevel documents. Tokens are unioned; invalid ids and grades with no
// matching class are ignored. An empty resolution returns [] so callers can
// fall back to "no restriction" rather than accidentally matching nothing.
async function resolveClassTokens(param) {
  if (!param) return [];
  const tokens = String(param)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const idSet = new Set();
  for (const token of tokens) {
    if (token.startsWith("grade:")) {
      const docs = await ClassLevel.find({ gradeLevel: token.slice("grade:".length) })
        .select("_id")
        .lean();
      docs.forEach((d) => idSet.add(String(d._id)));
    } else if (mongoose.isValidObjectId(token)) {
      idSet.add(token);
    }
  }
  if (idSet.size === 0) return [];
  return ClassLevel.find({ _id: { $in: [...idSet] } })
    .sort({ gradeLevel: 1, group: 1, section: 1 })
    .lean();
}

// ── Enhanced analytics: per-test stats, comparison, distribution ────────────
// Computes average, max, min, standard deviation for a selected test, scoped
// by class / student name / roll number / subject filters.  Also finds the
// most recent prior test for the same subject + class and returns the same
// stats for comparison.
exports.getEnhancedTestAnalyticsService = async (filters, res) => {
  const { testId, classLevelId, subjectId, nameSearch, rollNumberSearch, sortBy } = filters;

  // The class filter is a multi-select: a comma-separated list of ClassLevel
  // ids and/or "grade:<level>" tokens. Empty/invalid → no restriction.
  const selectedClasses = await resolveClassTokens(classLevelId);
  const selectedClassIds = selectedClasses.map((c) => String(c._id));

  // ── Load filter-option dropdowns ──
  const testQuery = {};
  if (subjectId) testQuery.subject = subjectId;
  if (selectedClassIds.length) testQuery.classLevels = { $in: selectedClassIds };

  const [classes, subjects, tests] = await Promise.all([
    ClassLevel.find().sort({ gradeLevel: 1, group: 1, section: 1 }).lean(),
    Subject.find().sort("name").lean(),
    Test.find(testQuery)
      .populate("subject", "name")
      .populate("classLevels", "name")
      .populate("week", "name startDate endDate")
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
  if (selectedClassIds.length) studentMatch.classLevel = { $in: selectedClassIds };
  if (nameSearch) studentMatch.name = { $regex: nameSearch, $options: "i" };
  if (rollNumberSearch) {
    studentMatch.rollNumber = { $regex: String(rollNumberSearch).trim(), $options: "i" };
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
  }).sort((a, b) => {
    if (sortBy === "rollAsc") {
      return String(a.rollNumber || "").localeCompare(String(b.rollNumber || ""), undefined, { numeric: true });
    }
    if (sortBy === "rollDesc") {
      return String(b.rollNumber || "").localeCompare(String(a.rollNumber || ""), undefined, { numeric: true });
    }
    return a.name.localeCompare(b.name);
  });

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
    filters: { testId, classLevelId, subjectId, nameSearch, rollNumberSearch, sortBy },
  });
};

// Helper: compute stats from an array of scores.
// Uses population stddev (divides by n, not n-1) because we treat the scores
// as the full set of interest (all students who took the test), not a sample
// from a larger population. This is the conventional choice for class-level
// descriptive statistics.
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
  // D-2: a legacy test with totalMarks 0 (or missing) makes the bucket maths
  // divide by zero — idx becomes NaN/Infinity and buckets[idx] is undefined,
  // throwing a TypeError. Bail out to an empty distribution instead.
  if (!totalMarks) return [];
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

  // Multi-select class filter: comma-separated ClassLevel ids and/or
  // "grade:<level>" tokens (same contract as the enhanced analytics).
  const selectedClasses = await resolveClassTokens(classLevelId);
  const selectedClassIds = selectedClasses.map((c) => String(c._id));

  // Shared dropdown data
  const [classes, subjects] = await Promise.all([
    ClassLevel.find().sort({ gradeLevel: 1, group: 1, section: 1 }).lean(),
    Subject.find().sort("name").lean(),
  ]);

  // Students list for the Mode A picker. Returned UNSCOPED (with each
  // student's class id) so the class dropdown can live-filter it on the
  // client without a round-trip; the trend itself is computed per student.
  const students = await Student.find({})
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

  // Mode B — class average trend, one line per selected class/section.
  // Picking a whole grade expands to all its sections, so e.g. grade 9's
  // Computer vs Biology vs Arts sections each get their own average-% line
  // for easy comparison. When nothing is selected a single blended
  // "All classes" line is returned (the original behaviour). Each line's
  // stats are scoped to that class's own students, not the whole test.
  if (mode === "class") {
    if (!subjectId) {
      return responseStatus(res, 200, "success", {
        mode: "class", classes, subjects, students, trend: [], tableRows: [],
      });
    }

    // Tests for this subject, restricted to the selected classes when any.
    const testQuery = { subject: subjectId };
    if (selectedClassIds.length) testQuery.classLevels = { $in: selectedClassIds };

    const tests = await Test.find(testQuery)
      .populate("subject", "name")
      .sort({ date: 1 })
      .lean();

    if (tests.length === 0) {
      return responseStatus(res, 200, "success", {
        mode: "class", classes, subjects, students, trend: [], tableRows: [],
      });
    }

    // Fetch every result for these tests with each student's class, then
    // bucket percentages by "classId|testId" (and a per-test "all" bucket).
    const testIds = tests.map((t) => t._id);
    const results = await TestResult.find({ test: { $in: testIds } })
      .populate("student", "classLevel")
      .lean();

    const testById = {};
    tests.forEach((t) => { testById[String(t._id)] = t; });

    const bucket = {};   // "classId|testId" -> [percent,...]
    const allBucket = {}; // testId -> [percent,...]
    results.forEach((r) => {
      const tid = String(r.test);
      const t = testById[tid];
      if (!t || !t.totalMarks) return;
      const pct = Math.round((r.score / t.totalMarks) * 10000) / 100;
      const clId = r.student && r.student.classLevel
        ? String(r.student.classLevel._id || r.student.classLevel)
        : "_none";
      const key = clId + "|" + tid;
      (bucket[key] = bucket[key] || []).push(pct);
      (allBucket[tid] = allBucket[tid] || []).push(pct);
    });

    const stat = (arr) => {
      if (!arr || arr.length === 0) return null;
      return {
        avgPercent: Math.round((arr.reduce((s, p) => s + p, 0) / arr.length) * 100) / 100,
        minPercent: Math.round(Math.min(...arr) * 100) / 100,
        maxPercent: Math.round(Math.max(...arr) * 100) / 100,
        count: arr.length,
      };
    };
    const classLabel = (c) =>
      `${c.gradeLevel ? c.gradeLevel + " \u2014 " : ""}${c.name}${c.group ? " (" + c.group + ")" : ""}`;

    // Which series to plot:
    //   • classes explicitly ticked → one line per selected class/section;
    //   • nothing ticked → one line per EVERY class that has results for this
    //     subject (the full list of classes), so the comparison is populated by
    //     default; a single blended "All classes" line only as a last-resort
    //     fallback when results carry no class attribution at all.
    let seriesClasses;
    if (selectedClassIds.length) {
      seriesClasses = selectedClasses;
    } else {
      const present = new Set();
      Object.keys(bucket).forEach((k) => {
        const cid = k.split("|")[0];
        if (cid && cid !== "_none") present.add(cid);
      });
      seriesClasses = classes.filter((c) => present.has(String(c._id)));
      if (seriesClasses.length === 0) {
        seriesClasses = [{ _id: null, name: "All classes" }];
      }
    }

    const lines = seriesClasses.map((c) => {
      const points = [];
      tests.forEach((t) => {
        const arr = c._id
          ? bucket[String(c._id) + "|" + String(t._id)] || []
          : allBucket[String(t._id)] || [];
        const s = stat(arr);
        if (!s) return;
        points.push({
          testName: t.name,
          date: t.date,
          avgPercent: s.avgPercent,
          minPercent: s.minPercent,
          maxPercent: s.maxPercent,
          count: s.count,
        });
      });
      return { className: classLabel(c), points };
    }).filter((l) => l.points.length > 0);

    // Flat rows for the table, tagging each point with its class.
    const tableRows = [];
    lines.forEach((l) => {
      l.points.forEach((p) => tableRows.push({ className: l.className, ...p }));
    });

    return responseStatus(res, 200, "success", {
      mode: "class", classes, subjects, students,
      trend: lines,
      tableRows,
    });
  }

  // No mode selected yet — just return dropdown data
  return responseStatus(res, 200, "success", {
    mode: null, classes, subjects, students, trend: [], tableRows: [],
  });
};

// ── Teacher analytics: per-class and per-session score stats ──────────────────
// Scoped to only the teacher's assigned subjects/classes (same assignment-gating
// pattern as getTeacherScopedTestsService). Reuses computeStats helper.
exports.getTeacherAnalyticsService = async (teacherId, filters, res) => {
  const Assignment = require("../../models/Academic/assignment.model");
  const { classLevel, subject, testId, sessionId, fromDate, toDate } = filters;

  // 1. Load teacher's assignments
  const assignments = await Assignment.find({ teacher: teacherId })
    .select("subject classLevel")
    .lean();

  if (assignments.length === 0) {
    const [classes, subjects, sessions] = await Promise.all([
      ClassLevel.find().sort({ gradeLevel: 1, group: 1 }).lean(),
      Subject.find().sort("name").lean(),
      TestSession.find().sort("name").lean(),
    ]);
    return responseStatus(res, 200, "success", {
      classes, subjects, sessions,
      perClass: [], perSession: [], overallStats: null,
    });
  }

  // Build subjectId -> Set<classLevelId> map (same pattern as getTeacherScopedTestsService)
  const subjectClassMap = {};
  assignments.forEach((a) => {
    const subId = a.subject.toString();
    if (!subjectClassMap[subId]) subjectClassMap[subId] = new Set();
    subjectClassMap[subId].add(a.classLevel.toString());
  });

  const teacherSubjectIds = Object.keys(subjectClassMap);
  const teacherClassLevelIds = [...new Set(assignments.map((a) => a.classLevel.toString()))];

  // 2. Resolve the class filter. It is a comma-separated list of tokens, each
  //    either a single classLevel id or a whole grade expressed as
  //    "grade:<level>" (e.g. "grade:9") which expands to every one of the
  //    teacher's classes in that grade. Multiple tokens are unioned, so a
  //    teacher can combine several sections at once. null = no restriction.
  let classFilterIds = null;
  const classTokens = classLevel
    ? String(classLevel).split(",").map((t) => t.trim()).filter(Boolean)
    : [];
  if (classTokens.length > 0) {
    const idSet = new Set();
    for (const token of classTokens) {
      if (token.startsWith("grade:")) {
        const gradeVal = token.slice("grade:".length);
        const gradeDocs = await ClassLevel.find({
          _id: { $in: teacherClassLevelIds },
          gradeLevel: gradeVal,
        }).select("_id").lean();
        const gradeIds = gradeDocs.map((d) => d._id.toString());
        if (gradeIds.length === 0) {
          return responseStatus(res, 403, "failed", "You are not assigned to any class in grade " + gradeVal);
        }
        gradeIds.forEach((id) => idSet.add(id));
      } else if (teacherClassLevelIds.includes(token)) {
        idSet.add(token);
      } else {
        return responseStatus(res, 403, "failed", "You are not assigned to this class");
      }
    }
    classFilterIds = [...idSet];
  }
  if (subject && !teacherSubjectIds.includes(subject)) {
    return responseStatus(res, 403, "failed", "You are not assigned to this subject");
  }

  // 3. Build test query scoped to teacher's subjects and classes
  const testQuery = { subject: { $in: teacherSubjectIds } };
  if (classFilterIds) testQuery.classLevels = { $in: classFilterIds };
  if (subject) testQuery.subject = subject;
  if (sessionId) testQuery.session = sessionId;
  if (testId) testQuery._id = testId;
  if (fromDate || toDate) {
    testQuery.date = {};
    if (fromDate) testQuery.date.$gte = new Date(fromDate);
    if (toDate) testQuery.date.$lte = new Date(toDate);
  }

  // 4. Load dropdown data (scoped to teacher's assignments)
  const [classes, subjects, sessions] = await Promise.all([
    ClassLevel.find({ _id: { $in: teacherClassLevelIds } }).sort({ gradeLevel: 1, group: 1 }).lean(),
    Subject.find({ _id: { $in: teacherSubjectIds } }).sort("name").lean(),
    TestSession.find().sort("name").lean(),
  ]);

  // 5. Find matching tests (filtered to teacher's class scope)
  const tests = await Test.find(testQuery)
    .populate("subject", "name")
    .populate("classLevels", "name")
    .populate("session", "name")
    .sort({ date: -1 })
    .lean();

  // Keep only tests where the teacher covers at least one of the test's classes
  const scopedTests = tests.filter((t) => {
    const subId = t.subject && t.subject._id ? t.subject._id.toString() : t.subject.toString();
    const classSet = subjectClassMap[subId];
    if (!classSet) return false;
    return (t.classLevels || []).some((cl) => {
      const clId = cl._id ? cl._id.toString() : cl.toString();
      return classSet.has(clId);
    });
  });

  if (scopedTests.length === 0) {
    return responseStatus(res, 200, "success", {
      classes, subjects, sessions,
      perClass: [], perSession: [], overallStats: null,
    });
  }

  // 6. Fetch all results for these tests
  const scopedTestIds = scopedTests.map((t) => t._id);
  const results = await TestResult.find({ test: { $in: scopedTestIds } })
    .populate("student", "name studentId classLevel")
    .lean();

  // 7. Per-class averages
  // Narrowed to the selected class/grade when a class filter is applied,
  // otherwise the teacher's full set of classes.
  const scopeClassIds = classFilterIds || teacherClassLevelIds;
  const perClassMap = {};
  results.forEach((r) => {
    const studentClassId = r.student && r.student.classLevel ? r.student.classLevel.toString() : null;
    if (!studentClassId) return;
    // Only include if this class is in the active scope
    if (!scopeClassIds.includes(studentClassId)) return;
    if (!perClassMap[studentClassId]) perClassMap[studentClassId] = [];
    perClassMap[studentClassId].push(r.score);
  });

  const classIdToName = {};
  classes.forEach((c) => { classIdToName[c._id.toString()] = c.name; });

  const perClass = Object.keys(perClassMap).map((clId) => {
    const scores = perClassMap[clId];
    // Compute percentage-based stats using actual test totalMarks
    const testMap = {};
    scopedTests.forEach((t) => { testMap[t._id.toString()] = t; });
    const percents = results
      .filter((r) => r.student && r.student.classLevel && r.student.classLevel.toString() === clId)
      .map((r) => {
        const t = testMap[r.test.toString()];
        return t && t.totalMarks ? Math.round((r.score / t.totalMarks) * 10000) / 100 : null;
      })
      .filter((p) => p !== null);

    return {
      classLevel: clId,
      className: classIdToName[clId] || "Unknown",
      avg: percents.length > 0 ? Math.round((percents.reduce((s, p) => s + p, 0) / percents.length) * 100) / 100 : null,
      min: percents.length > 0 ? Math.round(Math.min(...percents) * 100) / 100 : null,
      max: percents.length > 0 ? Math.round(Math.max(...percents) * 100) / 100 : null,
      count: percents.length,
    };
  }).sort((a, b) => (a.className || "").localeCompare(b.className || ""));

  // 8. Per-session averages
  const sessionMap = {};
  const testSessionMap = {};
  scopedTests.forEach((t) => {
    if (t.session) {
      const sId = t.session._id ? t.session._id.toString() : t.session.toString();
      if (!sessionMap[sId]) sessionMap[sId] = [];
      testSessionMap[sId] = t.session.name || "Session";
    }
  });

  results.forEach((r) => {
    const test = scopedTests.find((t) => t._id.toString() === r.test.toString());
    if (test && test.session) {
      const sId = test.session._id ? test.session._id.toString() : test.session.toString();
      const pct = test.totalMarks ? Math.round((r.score / test.totalMarks) * 10000) / 100 : null;
      if (pct !== null) sessionMap[sId].push(pct);
    }
  });

  const perSession = Object.keys(sessionMap).map((sId) => {
    const percents = sessionMap[sId];
    return {
      session: sId,
      sessionName: testSessionMap[sId] || "Unknown",
      avg: percents.length > 0 ? Math.round((percents.reduce((s, p) => s + p, 0) / percents.length) * 100) / 100 : null,
      min: percents.length > 0 ? Math.round(Math.min(...percents) * 100) / 100 : null,
      max: percents.length > 0 ? Math.round(Math.max(...percents) * 100) / 100 : null,
      count: percents.length,
    };
  }).sort((a, b) => (a.sessionName || "").localeCompare(b.sessionName || ""));

  // 9. Overall stats
  const allPercents = results
    .map((r) => {
      const t = scopedTests.find((t2) => t2._id.toString() === r.test.toString());
      return t && t.totalMarks ? Math.round((r.score / t.totalMarks) * 10000) / 100 : null;
    })
    .filter((p) => p !== null);

  const overallStats = allPercents.length > 0 ? {
    avg: Math.round((allPercents.reduce((s, p) => s + p, 0) / allPercents.length) * 100) / 100,
    min: Math.round(Math.min(...allPercents) * 100) / 100,
    max: Math.round(Math.max(...allPercents) * 100) / 100,
    count: allPercents.length,
  } : null;

  return responseStatus(res, 200, "success", {
    classes, subjects, sessions,
    perClass, perSession, overallStats,
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

  // Build report rows for a set of tests. D-2: guard the percent division so a
  // legacy totalMarks = 0 test yields a null percent instead of NaN%/Infinity%.
  const buildRows = (testList) =>
    testList
      .filter((t) => resultByTest[t._id.toString()] !== undefined)
      .map((t) => {
        const score = resultByTest[t._id.toString()];
        return {
          test: t.name,
          subject: t.subject ? t.subject.name : "Unknown",
          score,
          totalMarks: t.totalMarks,
          percent: t.totalMarks ? Math.round((score / t.totalMarks) * 10000) / 100 : null,
        };
      });

  // Average only over rows with a computable percent (skips null/guarded rows).
  const averageOf = (rows) => {
    const valid = rows.filter((r) => r.percent !== null);
    return valid.length > 0
      ? Math.round((valid.reduce((sum, r) => sum + r.percent, 0) / valid.length) * 100) / 100
      : null;
  };

  const phaseBlocks = session.phases
    .sort((a, b) => a.order - b.order)
    .map((phase) => {
      const rows = buildRows(tests.filter((t) => t.phase && t.phase.toString() === phase._id.toString()));
      return { phase: phase.name, order: phase.order, tests: rows, average: averageOf(rows) };
    });

  // D-1: session-scoped tests that carry no phase were previously dropped from
  // the report card entirely (rows are bucketed strictly by phase-id match).
  // Surface them in an explicit block so those scores are never silently
  // missing from a parent-facing document.
  const ungroupedRows = buildRows(tests.filter((t) => !t.phase));
  if (ungroupedRows.length > 0) {
    phaseBlocks.push({
      phase: "Not grouped into a phase",
      order: null,
      tests: ungroupedRows,
      average: averageOf(ungroupedRows),
    });
  }

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
