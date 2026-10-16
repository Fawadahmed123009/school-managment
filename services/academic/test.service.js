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
const TestAudit = require("../../models/Academic/testAudit.model");
const { getAssignedClassLevels } = require("./assignment.service");

// A pupil admitted AFTER a test was held never sat it, so they are not part of
// that test's roster and are never expected to have a score for it. The shared
// rule is day-granular and lives in utils/testRosterEligibility.js so the
// marks audit, the marking follow-up and the teacher dashboard all agree.
const { admissionCutoffForTest, isAdmittedByTest } = require("../../utils/testRosterEligibility");

// ── Multi-document atomicity (mirrors services/fees/fees.service.js, H6) ─────
// A test deletion writes MORE THAN ONE document: the append-only audit row plus
// the cascade removal of the test's TestResult rows and the Test itself. On the
// replica set (Atlas) those run inside a MongoDB transaction, so a failure at
// any step aborts and rolls the whole operation back — an audit row can never
// describe a deletion that did not happen, and a deletion can never happen
// without its audit row (fail-closed). Standalone deployments (and mocked unit
// tests) cannot start a session; the helper then degrades to running the steps
// in order, which still writes the audit FIRST so an untracked delete stays
// impossible.
async function withTransaction(body) {
  let session;
  try {
    session = mongoose.connection.client.startSession();
    session.startTransaction({
      readConcern: { level: "local" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
      maxCommitTimeMS: 60000,
    });
  } catch (err) {
    if (session) { try { session.endSession(); } catch (_) { /* best effort */ } }
    return body({ session: null });
  }
  try {
    const result = await body({ session });
    try {
      await session.commitTransaction();
    } catch (commitErr) {
      if (commitErr.codeName !== "UnknownTransactionCommitResult") throw commitErr;
      await session.commitTransaction();
    }
    return result;
  } catch (err) {
    try { await session.abortTransaction(); } catch (_) { /* already aborted */ }
    throw err;
  } finally {
    session.endSession();
  }
}

// Resolve the acting admin/manager's display identity from the DATABASE, keyed
// off the verified token id. Never trusts any role carried by the caller.
async function resolveAuditActor(actorId) {
  const Admin = require("../../models/Staff/admin.model");
  const admin = await Admin.findById(actorId).select("name role").lean();
  if (admin && admin.role === "admin") {
    return { actorRole: "admin", actorName: admin.name || null };
  }
  const teacher = await TeacherDoc.findById(actorId).select("name isAttendanceManager").lean();
  if (teacher && teacher.isAttendanceManager) {
    return { actorRole: "manager", actorName: teacher.name || null };
  }
  return { actorRole: null, actorName: teacher ? teacher.name || null : null };
}

// ── Shared create/update validators ──────────────────────────────────────────
// Editing a test must never be able to produce a state that creation would
// have rejected, so both paths run exactly these two checks.

/**
 * Session → phase → week must form a real chain. Returns null when the
 * placement is acceptable, otherwise the { code, message } to reject with.
 */
async function validateTestPlacement({ session, phase, week }) {
  if (!session) return null;

  const sessionDoc = await TestSession.findById(session);
  if (!sessionDoc) return { code: 404, message: "Session not found" };
  if (!phase) return null;

  const phaseExists = sessionDoc.phases.some((p) => p._id.toString() === phase);
  if (!phaseExists) return { code: 400, message: "Phase not found in this session" };

  // Week is required when both session and phase are set
  if (!week) {
    return { code: 400, message: "A week is required for session-based tests — select a week for this phase" };
  }

  // Validate that the selected week belongs to this session+phase
  const Week = require("../../models/Academic/week.model");
  const weekDoc = await Week.findById(week);
  if (!weekDoc || weekDoc.session.toString() !== session || weekDoc.phase.toString() !== phase) {
    return { code: 400, message: "The selected week does not belong to this session's phase" };
  }

  return null;
}

/**
 * Validate that the subject's appliesTo covers every classLevel in the test.
 * A test may target multiple classLevels at once; all must be valid for the
 * subject. Returns null when in scope, otherwise { code, message }.
 */
async function validateSubjectClassScope(subject, classLevels) {
  const subjectDoc = await Subject.findById(subject);
  if (!subjectDoc) return { code: 404, message: "Subject not found" };

  // Resolve every classLevel in ONE query (natural _id index) instead of a
  // findById per class.  We then walk the ORIGINAL classLevels order so the
  // first offending class still drives the rejection, preserving the exact
  // per-item behavior callers depend on:
  //   • a class id that doesn't exist       → 404 "Class not found"
  //   • a class the subject isn't taught in → 400 with that class's name/grade
  const ids = (Array.isArray(classLevels) ? classLevels : [classLevels]).filter(Boolean);
  const classDocs = ids.length
    ? await ClassLevel.find({ _id: { $in: ids } }).lean()
    : [];
  const docById = new Map(classDocs.map((d) => [String(d._id), d]));

  for (const clId of ids) {
    const classDoc = docById.get(String(clId));
    if (!classDoc) return { code: 404, message: "Class not found" };

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
      return {
        code: 400,
        message: `"${subjectDoc.name}" is not taught in "${classDoc.name}" (grade ${classDoc.gradeLevel}${classDoc.group ? ", " + classDoc.group : ""})`,
      };
    }
  }

  return null;
}

/**
 * Duplicate-detection: an existing test that occupies the same slot as the one
 * being written — same week, same subject, same calendar date, and the same set
 * of class levels. This is the shape a double-submitted "Create" or "Confirm
 * clone" produces (two byte-identical tests on one date), so both the create and
 * edit write paths reject it. `excludeId` lets an in-place edit ignore its own
 * document (only a collision with a *different* test is a problem).
 * Returns the duplicate document (with `name`) or null.
 */
async function findDuplicateTest({ subject, classLevels, date, week }, excludeId = null) {
  const query = { subject, date: new Date(date), week: week || null };
  if (excludeId) query._id = { $ne: excludeId };
  const candidates = await Test.find(query).lean();
  return candidates.find((c) => sameClassScope(c.classLevels, classLevels)) || null;
}

exports.createTestService = async (data, adminId, res) => {
  const { name, subject, classLevels, date, totalMarks, passMarks, session, phase, week } = data;

  if (!classLevels || classLevels.length === 0) {
    return responseStatus(res, 400, "failed", "A test needs at least one class");
  }

  const placementError = await validateTestPlacement({ session, phase, week });
  if (placementError) {
    return responseStatus(res, placementError.code, "failed", placementError.message);
  }

  const scopeError = await validateSubjectClassScope(subject, classLevels);
  if (scopeError) {
    return responseStatus(res, scopeError.code, "failed", scopeError.message);
  }

  // Block an identical test in the same slot (see findDuplicateTest). A double
  // click on "Create test" would otherwise post two byte-identical documents.
  const dupe = await findDuplicateTest({ subject, classLevels, date, week });
  if (dupe) {
    return responseStatus(
      res,
      409,
      "failed",
      `A test for the same subject, classes and date already exists here ("${dupe.name}"). Duplicate blocked — edit the existing test instead.`
    );
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

/**
 * One test, fully populated — the edit form needs the current values of every
 * field the create form offers. Admin/manager only (see the API route).
 */
exports.getTestByIdService = async (testId, res) => {
  const test = await Test.findById(testId)
    .populate("subject", "name displayName")
    .populate("classLevels", "_id name")
    .populate("session", "name")
    .populate("week", "name startDate endDate");
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  return responseStatus(res, 200, "success", test);
};

/** Compare two class sets by id, ignoring order (populate may return docs). */
function sameClassScope(a, b) {
  const norm = (list) =>
    [...new Set((list || []).map((c) => String(c && c._id ? c._id : c)))].sort();
  const left = norm(a);
  const right = norm(b);
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * Edit an existing test (admin/manager — "Manage tests" → Edit).
 *
 * Everything the create form offers is editable, under the same validations,
 * plus two guards that protect results already submitted:
 *   • subject / class scope is frozen once any score exists — stored results
 *     belong to that subject and that roster;
 *   • totalMarks can never be lowered below an already-entered score.
 * Category placement (session/phase/week) stays editable even with results
 * present, because it only groups the test for reporting — and a placement the
 * record already had is left alone, so legacy tests stay fixable.
 */
exports.updateTestService = async (testId, data, res) => {
  const { name, subject, classLevels, date, totalMarks, passMarks, session, phase, week } = data;

  const test = await Test.findById(testId);
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  if (!name || !String(name).trim()) {
    return responseStatus(res, 400, "failed", "Test name is required");
  }
  if (!classLevels || classLevels.length === 0) {
    return responseStatus(res, 400, "failed", "A test needs at least one class");
  }
  if (!date) return responseStatus(res, 400, "failed", "Test date is required");

  const total = Number(totalMarks);
  const pass = Number(passMarks);
  if (!Number.isFinite(total) || total < 1) {
    return responseStatus(res, 400, "failed", "Total marks must be a number of at least 1");
  }
  if (!Number.isFinite(pass) || pass < 0) {
    return responseStatus(res, 400, "failed", "Pass marks must be a number of 0 or more");
  }
  if (pass > total) {
    return responseStatus(res, 400, "failed", "Pass marks cannot exceed total marks");
  }

  // Normalise the category chain: a standalone test carries no phase/week, and
  // a session test without a phase carries no week (the form hides them).
  const placement = {
    session: session || null,
    phase: session && phase ? phase : null,
    week: session && phase && week ? week : null,
  };

  // Legacy records may already sit in a placement creation would reject (e.g. a
  // phase with no week). Re-validating an unchanged placement would make such a
  // test unrenamable, so the create rules are only applied when the placement
  // actually changes — re-categorising must produce a proper chain.
  const idOf = (v) => String((v && v._id) || v || "");
  const placementUnchanged =
    idOf(test.session) === idOf(placement.session) &&
    idOf(test.phase) === idOf(placement.phase) &&
    idOf(test.week) === idOf(placement.week);

  if (!placementUnchanged) {
    const placementError = await validateTestPlacement(placement);
    if (placementError) {
      return responseStatus(res, placementError.code, "failed", placementError.message);
    }
  }

  const scopeError = await validateSubjectClassScope(subject, classLevels);
  if (scopeError) {
    return responseStatus(res, scopeError.code, "failed", scopeError.message);
  }

  const resultCount = await TestResult.countDocuments({ test: testId });

  const scopeChanged = String(test.subject?._id || test.subject) !== String(subject) ||
    !sameClassScope(test.classLevels, classLevels);

  if (resultCount > 0 && scopeChanged) {
    return responseStatus(
      res,
      400,
      "failed",
      `Cannot change the subject or classes — ${resultCount} score(s) have already been submitted for this test. Correct the scores first, or delete the test and create it again.`
    );
  }

  // Shrinking the scale must not orphan scores above the new maximum.
  if (resultCount > 0 && total !== test.totalMarks) {
    const tooHigh = await TestResult.find({ test: testId, score: { $gt: total } }).populate("student", "name");
    if (tooHigh.length > 0) {
      const details = tooHigh
        .slice(0, 5)
        .map((r) => `${r.score}${r.student?.name ? " (" + r.student.name + ")" : ""}`)
        .join(", ");
      return responseStatus(
        res,
        400,
        "failed",
        `Cannot lower total marks below ${total} — ${tooHigh.length} entered score(s) exceed it (${details}${tooHigh.length > 5 ? ", …" : ""}). Remove or correct those scores first.`
      );
    }
  }

  // Editing must not push this test onto a slot another identical test already
  // occupies (same week/subject/date/classes). Its own document is excluded, so
  // saving unchanged or renaming is always allowed — only a genuine collision is
  // blocked. This is the "keep only the edited one" guarantee.
  const dupe = await findDuplicateTest(
    { subject, classLevels, date, week: placement.week },
    testId
  );
  if (dupe) {
    return responseStatus(
      res,
      409,
      "failed",
      `Another test for the same subject, classes and date already exists here ("${dupe.name}"). Edit that test instead of creating a duplicate.`
    );
  }

  test.name = String(name).trim();
  test.subject = subject;
  test.classLevels = classLevels;
  test.date = date;
  test.totalMarks = total;
  test.passMarks = pass;
  test.session = placement.session;
  test.phase = placement.phase;
  test.week = placement.week;
  await test.save();

  return responseStatus(res, 200, "success", test);
};

exports.getAllTestsService = async (res) => {
  const tests = await Test.find({})
    .populate("subject", "name displayName")
    // gradeLevel too: the Manage-tests ledger cascade offers a Grade level,
    // whose options are derived from the rendered rows.
    .populate("classLevels", "name gradeLevel")
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
    .populate("subject", "name displayName")
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
// Seven-level step-down cascade for the teacher marking pages (manual
// mark-entry and OCR):
//   Session → Grade → Section → Phase → Week → Subject → Test
// Every level is server-derived from the teacher's own Assignment records: a
// level only ever offers values that at least one (subject, classLevel)
// assignment pair of THIS teacher actually has a test for. Client-supplied ids
// are never trusted — they only ever narrow the pair-scoped query, so a
// foreign id can at most produce an empty list or a 403, never foreign data.
//
// Performance: the data is tiny (<300 documents), the felt cost is the number
// of SERIALIZED Atlas round-trips. Each level therefore resolves its
// independent reads (assignment pairs, distinct ids, "unassigned" counts,
// session doc) in as few Promise.all batches as the dependencies allow, and
// every read is .lean().

/**
 * Legacy level kept for the mark-entry pages' server-rendered "No classes
 * assigned" empty state: distinct classes the teacher is assigned to.
 * Returns classLevel documents with _id and name.
 */
exports.getTeacherAssignedClassesService = async (teacherId, res) => {
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

// PG first, then 1–12 numerically (gradeLevel is stored as a string) — the
// same ordering the marks-audit and PDF-report cascades use, so pages agree.
const GRADE_ORDER = ["PG", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const gradeRank = (g) => {
  const i = GRADE_ORDER.indexOf(String(g));
  return i === -1 ? GRADE_ORDER.length : i;
};

/**
 * The ONE scoping source for every cascade level: the teacher's own
 * (subject, classLevel) assignment pairs, lean, fetched once per request.
 */
async function getTeacherAssignmentPairs(teacherId) {
  return Assignment.find({ teacher: teacherId }).select("subject classLevel").lean();
}

/**
 * A Test query matching a set of assignment pairs: each clause pins ONE
 * subject together with ONE classLevel the teacher is actually assigned to
 * teach it in. Pair-wise on purpose — two separate $ins would over-match
 * (a test for a subject the teacher holds only in a DIFFERENT section of the
 * same grade would slip through), which is exactly the section leak this
 * cascade must never have.
 */
function pairMatch(pairs) {
  return { $or: pairs.map((p) => ({ subject: p.subject, classLevels: p.classLevel })) };
}

/** Session filter from the client: "none" = the bucket of tests without a session. */
function sessionMatch(sessionParam) {
  return sessionParam === "none" ? { session: null } : { session: sessionParam };
}

/**
 * Guard shared by every level below Grade: the teacher must hold at least one
 * assignment for every selected classLevel (section). Accepts a single section
 * id OR a comma-separated list — the "All sections" cascade option sends every
 * section of the chosen grade, and the guard admits only the union of pairs
 * behind those ids. Returns the matching pairs, or null after writing a 403 —
 * a crafted id (or one smuggled into a list) can never read past this point.
 * The comparison is against DB-sourced pair ids, so any malformed or foreign
 * string simply fails to match (fail closed).
 */
function sectionPairsOrForbidden(pairs, sectionParam, res) {
  const forbidden = () => {
    responseStatus(res, 403, "failed", "You are not assigned to this class");
    return null;
  };
  const wanted = String(sectionParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) return forbidden();

  const assigned = new Set(pairs.map((p) => String(p.classLevel)));
  // EVERY requested id must be assigned — a list mixing one valid section with
  // a foreign id is rejected outright, never silently narrowed.
  if (wanted.some((id) => !assigned.has(id))) return forbidden();

  const wantedSet = new Set(wanted);
  const sectionPairs = pairs.filter((p) => wantedSet.has(String(p.classLevel)));
  if (sectionPairs.length === 0) return forbidden();
  return sectionPairs;
}

/**
 * Level 1 — Session: distinct sessions across ALL of the teacher's assigned
 * tests. Deliberately takes no client filters: the teacher's placements are
 * always placement-consistent (validateTestPlacement), so any assigned test
 * that has a session makes that session legitimately selectable at level 1.
 * hasUnassigned surfaces the "tests with no session" bucket.
 */
exports.getTeacherCascadeSessionsService = async (teacherId, res) => {
  const pairs = await getTeacherAssignmentPairs(teacherId);
  if (pairs.length === 0) {
    return responseStatus(res, 200, "success", { sessions: [], hasUnassigned: false });
  }

  const base = pairMatch(pairs);
  // Independent reads → one parallel batch (was 2 serialized round-trips).
  const [sessionIds, unassignedCount] = await Promise.all([
    Test.distinct("session", { ...base, session: { $ne: null } }),
    Test.countDocuments({ ...base, session: null }),
  ]);

  const sessions = sessionIds.length > 0
    ? await TestSession.find({ _id: { $in: sessionIds } }).select("name").sort("name").lean()
    : [];

  return responseStatus(res, 200, "success", { sessions, hasUnassigned: unassignedCount > 0 });
};

/**
 * Level 2 — Grade: distinct grade levels among the teacher's ASSIGNED classes
 * that actually have a test in the selected session. Grade is derived only
 * from the teacher's own ClassLevels — school-wide grades never appear.
 * sessionParam is required (an id, or "none" for tests without a session).
 */
exports.getTeacherCascadeGradesService = async (teacherId, sessionParam, res) => {
  if (!sessionParam) {
    return responseStatus(res, 400, "failed", "session is required");
  }

  const pairs = await getTeacherAssignmentPairs(teacherId);
  if (pairs.length === 0) {
    return responseStatus(res, 200, "success", { grades: [] });
  }

  const pairClassIds = [...new Set(pairs.map((p) => p.classLevel))];
  // Both reads depend only on teacherId/session → ONE parallel batch.
  const [testClassIds, classDocs] = await Promise.all([
    Test.distinct("classLevels", { ...pairMatch(pairs), ...sessionMatch(sessionParam) }),
    ClassLevel.find({ _id: { $in: pairClassIds } }).select("gradeLevel").lean(),
  ]);

  const onTest = new Set(testClassIds.map(String));
  const grades = [
    ...new Set(
      classDocs
        .filter((d) => d.gradeLevel && onTest.has(String(d._id)))
        .map((d) => String(d.gradeLevel))
    ),
  ].sort((a, b) => gradeRank(a) - gradeRank(b));

  return responseStatus(res, 200, "success", { grades });
};

/**
 * Level 3 — Section: the teacher's assigned classes within one grade that
 * have a test in the selected session. The grade is validated against the
 * teacher's own classes (a crafted grade yields 403, never another
 * teacher's sections), and the section list is intersected with the
 * assignment pairs — never with school-wide classes.
 */
exports.getTeacherCascadeSectionsService = async (teacherId, sessionParam, gradeParam, res) => {
  if (!sessionParam || !gradeParam) {
    return responseStatus(res, 400, "failed", "session and grade are required");
  }

  const pairs = await getTeacherAssignmentPairs(teacherId);
  if (pairs.length === 0) {
    return responseStatus(res, 200, "success", { sections: [] });
  }

  const pairClassIds = [...new Set(pairs.map((p) => p.classLevel))];
  const [testClassIds, classDocs] = await Promise.all([
    Test.distinct("classLevels", { ...pairMatch(pairs), ...sessionMatch(sessionParam) }),
    ClassLevel.find({ _id: { $in: pairClassIds } }).select("name gradeLevel group section").lean(),
  ]);

  // Security: the requested grade must be one the teacher is assigned in.
  const assignedGrades = new Set(classDocs.map((d) => String(d.gradeLevel)));
  if (!assignedGrades.has(String(gradeParam))) {
    return responseStatus(res, 403, "failed", "You are not assigned to any class in this grade");
  }

  const onTest = new Set(testClassIds.map(String));
  const sections = classDocs
    .filter((d) => String(d.gradeLevel) === String(gradeParam) && onTest.has(String(d._id)))
    .map((d) => ({ _id: d._id, name: d.name, gradeLevel: d.gradeLevel, group: d.group, section: d.section }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return responseStatus(res, 200, "success", { sections });
};

/**
 * Level 4 — Phase: distinct phases among tests for the selected
 * session + the teacher's assigned subjects in the selected section. The
 * section id is re-verified against the assignment pairs before any Test
 * read; the three remaining independent reads run in ONE parallel batch.
 */
exports.getTeacherCascadePhasesService = async (teacherId, sessionParam, sectionParam, res) => {
  if (!sessionParam || !sectionParam) {
    return responseStatus(res, 400, "failed", "session and section are required");
  }
  if (sessionParam === "none") {
    return responseStatus(res, 400, "failed", "A real session is required to list phases");
  }

  const pairs = await getTeacherAssignmentPairs(teacherId);
  const sectionPairs = sectionPairsOrForbidden(pairs, sectionParam, res);
  if (!sectionPairs) return undefined;

  const base = { ...pairMatch(sectionPairs), session: sessionParam };
  const [phaseIds, unassignedCount, sessionDoc] = await Promise.all([
    Test.distinct("phase", { ...base, phase: { $ne: null } }),
    Test.countDocuments({ ...base, phase: null }),
    TestSession.findById(sessionParam).select("phases").lean(),
  ]);

  // Phase subdocs come from the session document, in their defined order.
  let phases = [];
  if (sessionDoc) {
    const idSet = new Set(phaseIds.map(String));
    phases = (sessionDoc.phases || [])
      .filter((p) => idSet.has(String(p._id)))
      .sort((a, b) => a.order - b.order);
  }

  return responseStatus(res, 200, "success", { phases, hasUnassigned: unassignedCount > 0 });
};

/**
 * Level 5 — Week: weeks of the selected session+phase that actually have a
 * test for this teacher in the selected section. Same section guard and
 * pair-scoped match as phases; the two Test reads run in parallel before the
 * dependent Week lookup.
 */
exports.getTeacherCascadeWeeksService = async (teacherId, sessionParam, sectionParam, phaseParam, res) => {
  const Week = require("../../models/Academic/week.model");

  if (!sessionParam || !sectionParam || !phaseParam) {
    return responseStatus(res, 400, "failed", "session, section, and phase are required");
  }
  if (sessionParam === "none" || phaseParam === "none") {
    return responseStatus(res, 400, "failed", "A real session and phase are required to list weeks");
  }

  const pairs = await getTeacherAssignmentPairs(teacherId);
  const sectionPairs = sectionPairsOrForbidden(pairs, sectionParam, res);
  if (!sectionPairs) return undefined;

  const base = { ...pairMatch(sectionPairs), session: sessionParam, phase: phaseParam };
  const [weekIds, unassignedCount] = await Promise.all([
    Test.distinct("week", { ...base, week: { $ne: null } }),
    Test.countDocuments({ ...base, week: null }),
  ]);

  const weeks = weekIds.length > 0
    ? await Week.find({ _id: { $in: weekIds } }).select("name startDate endDate").sort("startDate").lean()
    : [];

  return responseStatus(res, 200, "success", { weeks, hasUnassigned: unassignedCount > 0 });
};

/**
 * Level 6 — Subject: subjects that have a test in the selected
 * session [+ phase/week when chosen] for the selected section, intersected
 * with the subjects THIS teacher is assigned to in that section. Because
 * every upstream filter is part of the Test query, a subject only ever
 * appears when a markable test actually exists behind it — no dead ends.
 */
exports.getTeacherCascadeSubjectsService = async (teacherId, sessionParam, sectionParam, phaseParam, weekParam, res) => {
  if (!sessionParam || !sectionParam) {
    return responseStatus(res, 400, "failed", "session and section are required");
  }

  const pairs = await getTeacherAssignmentPairs(teacherId);
  const sectionPairs = sectionPairsOrForbidden(pairs, sectionParam, res);
  if (!sectionPairs) return undefined;

  const match = { ...pairMatch(sectionPairs), ...sessionMatch(sessionParam) };
  if (phaseParam) {
    match.phase = phaseParam === "none" ? null : phaseParam;
  }
  if (weekParam) {
    match.week = weekParam === "none" ? null : weekParam;
  }

  const testSubjectIds = await Test.distinct("subject", match);

  // The pair guard above already restricts to assigned (subject, section)
  // combinations; intersect once more in memory so a subject can only be
  // offered when the teacher holds it for this exact section.
  const assignedSubjects = new Set(sectionPairs.map((p) => String(p.subject)));
  const scopedIds = testSubjectIds.filter((id) => assignedSubjects.has(String(id)));

  const subjects = scopedIds.length > 0
    ? await Subject.find({ _id: { $in: scopedIds } }).select("name displayName").sort("name").lean()
    : [];

  return responseStatus(res, 200, "success", subjects);
};

/**
 * Level 7 — Test: tests matching the full upstream chain (section + subject
 * + optional session/phase/week). classLevel accepts a comma-separated string
 * of class ids or a single id; "none" resolves session/phase/week to the
 * no-category bucket.
 *
 * Security: validates that the teacher is actually assigned to this
 * subject for at least one of the selected classes.
 *
 * Performance: lean + projection — the dropdown only renders _id/name/date,
 * and the four populates used to cost four extra serialized Atlas round-trips
 * per click. Traced every consumer: only public/js/test-cascade-filters.js
 * reads the payload (label text + id, no document methods).
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
    .select("_id name date")
    .sort({ date: -1 })
    .lean();

  return responseStatus(res, 200, "success", tests);
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

  // Build the roster query. Two independent exclusions apply:
  //   • A pupil admitted AFTER the test was held was not in the class yet and
  //     must not appear on its mark-entry roster. `$not $gt` keeps students with
  //     no recorded admission date visible (mirrors the day-granular cutoff used
  //     by the write path, the marks audit and marking follow-up).
  //   • A pupil who is no longer enrolled (status inactive / graduated /
  //     withdrawn) must never be offered for marking. Same active-student
  //     convention as the marks-audit expected roster, fees and attendance, so a
  //     test is never shown as needing marks for a child the school has let go.
  //     Historical TestResult rows already recorded for such a pupil stay visible
  //     in every report — this only removes them from the mark-ENTRY picker.
  const rosterQuery = {
    classLevel: { $in: assignedClassLevels },
    status: { $ne: "inactive" },
    isGraduated: { $ne: true },
    isWithdrawn: { $ne: true },
  };
  const admissionCutoff = admissionCutoffForTest(test.date);
  if (admissionCutoff) rosterQuery.dateAdmitted = { $not: { $gt: admissionCutoff } };

  const students = await Student.find(rosterQuery)
    .select("name studentId rollNumber classLevel fatherName parent")
    .populate("parent", "name");

  // Marks timeline: updatedAt is when the teacher last saved/edited the score,
  // createdAt is the original upload — both surface in the roster UI and audit.
  const existing = await TestResult.find({ test: testId }).populate("markedBy", "name").lean();
  const existingMap = {};
  existing.forEach((r) => {
    existingMap[r.student.toString()] = {
      score: r.score,
      // Legacy rows predate the absent flag and recorded an absence as a bare
      // score 0, so treat both the flag and a 0 as absent for display ("A").
      absent: r.absent === true || r.score === 0,
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
      // Whether the saved row is an absence — the roster renders "A" for these.
      absent: prev ? prev.absent : false,
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

  // An empty mark (null / undefined / "") means the pupil was ABSENT for this
  // test. Absences are stored as score 0 + absent true so the numeric column
  // stays intact for every legacy reader, while the flag lets the UI show "A"
  // and the analytics exclude the row from all averages. A typed 0 is treated
  // the same way (0 has always meant "absent" in this system's marks audit).
  const normalized = records.map((r) => {
    const blank = r.score === null || r.score === undefined || r.score === "";
    const score = blank ? 0 : Number(r.score);
    return { student: r.student, score, absent: blank || score === 0 };
  });

  // Reject any present score that is negative or exceeds the test's totalMarks.
  const invalidScores = normalized.filter(
    (r) => !r.absent && (typeof r.score !== "number" || isNaN(r.score) || r.score < 0 || r.score > test.totalMarks)
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

  // Same rule as the roster, enforced on the write path: a pupil admitted AFTER
  // the test was held is not on its roster, so their score cannot be recorded
  // either (via the UI or a direct API call). `$gt` on the day-granular cutoff
  // only rejects strictly-later admissions, leaving students with no recorded
  // admission date untouched.
  const admissionCutoff = admissionCutoffForTest(test.date);
  if (admissionCutoff) {
    const admittedLate = await Student.find({
      _id: { $in: submittedIds },
      dateAdmitted: { $gt: admissionCutoff },
    }).select("_id name");
    if (admittedLate.length > 0) {
      return responseStatus(
        res,
        403,
        "failed",
        `Cannot record scores for students admitted after this test's date: ${admittedLate
          .map((s) => s.name)
          .join(", ")}`
      );
    }
  }

  // Same rule as the roster, enforced on the write path: a pupil who is no
  // longer enrolled (inactive / graduated / withdrawn) is not on any mark-entry
  // roster, so their score cannot be recorded either — via the UI or a direct
  // API call. Hiding the row in the roster isn't enough on its own. Rejected as
  // a fail-closed batch so nothing is written when any submitted pupil is out.
  const notEnrolled = await Student.find({
    _id: { $in: submittedIds },
    $or: [
      { status: "inactive" },
      { isGraduated: true },
      { isWithdrawn: true },
    ],
  }).select("_id name");
  if (notEnrolled.length > 0) {
    return responseStatus(
      res,
      403,
      "failed",
      `Cannot record scores for students who are no longer enrolled: ${notEnrolled
        .map((s) => s.name)
        .join(", ")}`
    );
  }

  const results = [];
  for (const r of normalized) {
    const updated = await TestResult.findOneAndUpdate(
      { test: testId, student: r.student },
      { test: testId, student: r.student, score: r.score, absent: r.absent, markedBy: teacherId },
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
 * can also see what is still unmarked. Marking status is derived from the
 * class rosters: a test is `marked` once every ACTIVE student of its classes
 * has a score row (0 = absent counts as submitted); anything else is
 * `unmarked`. Only unmarked tests are flagged — `overdue` past
 * {@link OVERDUE_MS} and `critical` past {@link CRITICAL_MS} since the test
 * date — so a finished test never shows a reminder. Optional filters:
 * `search` (test / subject / class), `teacher` — a marker's id, or any part of
 * the marker's name (the audit page's typeahead sends a typed name) — keeping
 * only the tests that teacher marked — `status` (marked / unmarked), the
 * category cascade `session` / `phase` / `week` (ids; "none" keeps only tests
 * missing that category), the class cascade `grade` (a ClassLevel gradeLevel
 * string, e.g. "5" or "PG") / `classLevel` (a ClassLevel id) — a test can
 * target several classes, so it matches when ANY of its classes sits in the
 * chosen grade or is the chosen class, and "none" keeps tests whose classes
 * carry no grade / no class at all — and `subject` (a Subject id, or part of
 * its display label). The audit page stacks these as
 * session → grade → phase → week → subject. Rows are ordered by urgency: critical,
 * then overdue, then the rest most-recently-touched first, fully marked
 * tests last. Response is paginated (`page` / `limit`, max 100; `limit=all`
 * returns every row) and carries a `pagination` envelope with the
 * unpaginated total. Read-only, admin/manager only.
 */
exports.getMarksAuditService = async (query, res) => {
  const {
    search,
    teacher,
    status,
    session,
    phase,
    week,
    grade,
    classLevel,
    subject,
    page,
    limit,
  } = query || {};

  const tests = await Test.find({})
    .populate("subject", "name displayName")
    .populate("classLevels", "name gradeLevel group")
    .populate("session", "name")
    .populate("week", "name startDate")
    .sort({ date: -1 })
    .lean();

  // A Test stores `phase` as a bare subdocument id (no ref), so its name has
  // to be resolved from the owning TestSession's phases array. The subdoc's
  // `order` travels with it so the audit page can list phases chronologically
  // instead of in ledger (urgency) order.
  const sessionsForPhases = await TestSession.find({}).select("phases").lean();
  const phaseNames = {};
  const phaseOrders = {};
  sessionsForPhases.forEach((s) =>
    (s.phases || []).forEach((p) => {
      phaseNames[String(p._id)] = p.name;
      phaseOrders[String(p._id)] = Number.isFinite(p.order) ? p.order : null;
    })
  );

  // Group every TestResult by test to derive per-test stats + timeline.
  const results = await TestResult.find({})
    .select("test student score createdAt updatedAt markedBy")
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
  const [assignments, teachers, admissionsByClass] = await Promise.all([
    Assignment.find().select("teacher subject classLevel").lean(),
    TeacherDoc.find().select("name whatsappNumber").lean(),
    // Roster membership per class — the pupils a test is measured against to be
    // "marked". Same active-student convention as the fees and alerts services
    // (inactive / graduated / withdrawn pupils are skipped). Each class keeps
    // the list of its pupils' admission dates so the completion count can drop
    // anyone admitted AFTER a given test's date (they weren't in the class yet
    // and can never be expected to have a score for it).
    Student.find({
      classLevel: { $exists: true, $ne: null },
      status: { $ne: "inactive" },
      isGraduated: { $ne: true },
      isWithdrawn: { $ne: true },
    })
      .select("classLevel dateAdmitted")
      .lean()
      .then((rows) => {
        const byClass = {};
        rows.forEach((s) => {
          const cid = asRefId(s.classLevel);
          if (cid) (byClass[cid] || (byClass[cid] = [])).push(s.dateAdmitted || null);
        });
        return byClass;
      }),
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

  // A test older than this many days (by its own date) is flagged overdue;
  // past CRITICAL_MS a still-unmarked test turns red.
  const OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;
  const CRITICAL_MS = 5 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();

  const round2 = (n) => Math.round(n * 100) / 100;

  // Class keys per test for the grade / class filters. A test can target
  // several ClassLevels, so each row carries all of them (id + grade
  // level + group) — a filter matches when ANY one of them is chosen.
  const classKeysFor = (t) =>
    (t.classLevels || []).map((c) => ({
      id: asRefId(c) || "",
      name: (c && c.name) || "",
      gradeLevel: (c && c.gradeLevel) || "",
      group: (c && c.group) || "",
    }));

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

    // Marking completion: every active student of the test's classes who had
    // already been admitted by the test's date must have a score row (a 0 =
    // absent is still a submitted entry). Distinct pupils are counted, not raw
    // rows, and overspill (rows for students who left the class after being
    // marked) must not keep a test stuck as unmarked. A pupil admitted AFTER the
    // test was held is not part of this test's roster and is never expected.
    const testAdmissionCutoff = admissionCutoffForTest(t.date);
    const expectedCount = (t.classLevels || []).reduce((n, c) => {
      const admissions = admissionsByClass[asRefId(c)] || [];
      return n + admissions.filter((admitted) => isAdmittedByTest(admitted, testAdmissionCutoff)).length;
    }, 0);
    const markedStudentIds = new Set(rs.map((r) => String(r.student)));
    const fullyMarked = expectedCount > 0 && markedStudentIds.size >= expectedCount;

    // Urgency flags apply ONLY while marking is outstanding: a completed test
    // is never overdue, never critical and never needs a reminder.
    const testTime = t.date ? new Date(t.date).getTime() : null;
    const pastDue = testTime != null && nowMs - testTime > OVERDUE_MS;
    const overdue = !fullyMarked && pastDue;
    const critical = !fullyMarked && testTime != null && nowMs - testTime > CRITICAL_MS;

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

    const classKeys = classKeysFor(t);

    return {
      testId: t._id,
      name: t.name,
      // Display label only — falls back to the internal name. Grouping/scoping
      // above keys off subject ids, never this string.
      subject: t.subject ? (t.subject.displayName || t.subject.name) : "",
      // Subject id for the cascade's last level — the label above is for
      // display only, never for matching.
      subjectId: t.subject && t.subject._id ? String(t.subject._id) : null,
      classes: (t.classLevels || []).map((c) => c.name).join(", "),
      // Category keys + labels for the session/phase/week cascade filters.
      session: t.session ? String(t.session._id) : null,
      sessionName: t.session ? t.session.name : "",
      phase: t.phase ? String(t.phase) : null,
      phaseName: t.phase ? phaseNames[String(t.phase)] || "" : "",
      phaseOrder: t.phase ? phaseOrders[String(t.phase)] ?? null : null,
      week: t.week ? String(t.week._id) : null,
      weekName: t.week ? t.week.name : "",
      // Calendar start of the week: the audit page lists its week dropdown
      // chronologically instead of in ledger (urgency) order.
      weekStart: t.week && t.week.startDate ? t.week.startDate : null,
      // Grade / class keys: the page's cascade filters by grade (a test is kept
      // when ANY of its classes sits in it); the class keys back the `classLevel`
      // API filter and each row's own class scoping.
      gradeLevels: [...new Set(classKeys.map((c) => c.gradeLevel).filter(Boolean))],
      classLevels: classKeys,
      totalMarks: t.totalMarks,
      passMarks: t.passMarks,
      testDate: t.date,
      markedCount: rs.length,
      // Marking completion (see above): the roster the test is measured
      // against, and whether every one of those students has a score.
      expectedCount,
      fullyMarked,
      status: fullyMarked ? "marked" : "unmarked",
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
      critical,
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

  // Teacher filter: the marker's id exactly, or any part of the marker's name
  // (case-insensitive) — the audit page offers a typeahead, so a typed "ayesha"
  // has to find "Ms. Ayesha". Tests the teacher never marked — including
  // unmarked ones — are excluded.
  if (teacher && String(teacher).trim()) {
    const tq = String(teacher).trim().toLowerCase();
    rows = rows.filter(
      (r) =>
        r.markers.some((m) => m.id.toLowerCase() === tq || (m.name || "").toLowerCase().includes(tq))
    );
  }

  // Category cascade: exact id match; "none" keeps tests missing that level.
  const catMatch = (raw, value) => {
    if (!value || !String(value).trim()) return true;
    const v = String(value).trim().toLowerCase();
    return v === "none" ? !raw : String(raw || "").toLowerCase() === v;
  };
  rows = rows.filter(
    (r) => catMatch(r.session, session) && catMatch(r.phase, phase) && catMatch(r.week, week)
  );

  // Grade / class filters: a test targets a LIST of classes, so it is kept
  // when ANY of them matches. "none" keeps rows whose list is empty (a test
  // with no grade level, or with no classes at all).
  const anyMatch = (values, value) => {
    if (!value || !String(value).trim()) return true;
    const v = String(value).trim().toLowerCase();
    return v === "none" ? values.length === 0 : values.some((x) => String(x).toLowerCase() === v);
  };
  rows = rows.filter(
    (r) =>
      anyMatch(r.gradeLevels, grade) && anyMatch(r.classLevels.map((c) => c.id), classLevel)
  );

  // Subject filter: a Subject id (what the cascade dropdown submits), or any
  // part of its display label when the API is queried directly by name.
  if (subject && String(subject).trim()) {
    const sq = String(subject).trim().toLowerCase();
    rows = rows.filter(
      (r) => String(r.subjectId || "").toLowerCase() === sq || (r.subject || "").toLowerCase().includes(sq)
    );
  }

  // Marking-status filter: "marked" = every student's marks are uploaded,
  // "unmarked" = anything still outstanding (including partially marked).
  const statusQ = String(status || "").trim().toLowerCase();
  if (statusQ === "marked" || statusQ === "unmarked") {
    rows = rows.filter((r) => r.status === statusQ);
  }

  // Urgency first: critical (red), then overdue, then everything still
  // awaiting marking in most-recently-touched order; fully marked tests sink
  // to the bottom of the list.
  const urgency = (r) => (r.critical ? 0 : r.overdue ? 1 : r.fullyMarked ? 3 : 2);
  const touched = (r) =>
    r.lastUpdateAt ? new Date(r.lastUpdateAt).getTime() : new Date(r.testDate || 0).getTime();
  rows.sort((a, b) => {
    if (urgency(a) !== urgency(b)) return urgency(a) - urgency(b);
    return touched(b) - touched(a);
  });

  const total = rows.length;
  if (String(limit).toLowerCase() === "all") {
    return responseStatus(res, 200, "success", {
      rows,
      pagination: { total, page: 1, limit: total, pages: 1, hasPrev: false, hasNext: false },
    });
  }
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const lm = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const pages = Math.ceil(total / lm) || 1;
  const paged = rows.slice((pg - 1) * lm, (pg - 1) * lm + lm);

  return responseStatus(res, 200, "success", {
    rows: paged,
    pagination: {
      total,
      page: Math.min(pg, pages),
      limit: lm,
      pages,
      hasPrev: pg > 1,
      hasNext: pg < pages,
    },
  });
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
    .populate("subject", "name displayName")
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

  const tests = await Test.find(testQuery).populate("subject", "name displayName");
  const testIds = tests.map((t) => t._id);

  const resultQuery = { test: { $in: testIds } };
  if (studentId) resultQuery.student = studentId;

  const results = await TestResult.find(resultQuery)
    .populate("student", "name studentId")
    .populate({ path: "test", populate: { path: "subject", select: "name displayName" } });

  const summary = results.map((r) => ({
    student: r.student,
    test: r.test.name,
    // Display label — no downstream logic keys off this string.
    subject: r.test.subject ? (r.test.subject.displayName || r.test.subject.name) : "Unknown",
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
  const gradeSet = new Set();
  // Token parsing does no DB work — grade tokens are batched into one query.
  for (const token of tokens) {
    if (token.startsWith("grade:")) {
      gradeSet.add(token.slice("grade:".length));
    } else if (mongoose.isValidObjectId(token)) {
      idSet.add(token);
    }
  }
  // One query resolves every "grade:<level>" token at once (was one per grade).
  if (gradeSet.size > 0) {
    const docs = await ClassLevel.find({ gradeLevel: { $in: [...gradeSet] } })
      .select("_id")
      .lean();
    docs.forEach((d) => idSet.add(String(d._id)));
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
      .populate("subject", "name displayName")
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
    .populate("subject", "name displayName")
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

  const scores = results.filter((r) => !r.absent && r.score > 0).map((r) => r.score);
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
      // Absent pupils (blank mark, stored as score 0 + absent) are shown as "A"
      // in the table and excluded from the stats above.
      absent: r.absent === true || r.score === 0,
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
      .populate("subject", "name displayName")
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
      const prevScores = prevResults.filter((r) => !r.absent && r.score > 0).map((r) => r.score);
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
exports.validateSubjectClassScope = validateSubjectClassScope;
exports.resolveClassTokens = resolveClassTokens;

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
        populate: [{ path: "subject", select: "name displayName" }],
      })
      .lean();

    // Filter by subject if requested; drop absences (blank mark, stored as a
    // score 0 + absent) so they never appear as a false 0% dip in the trend.
    const filtered = results.filter((r) => {
      if (!r.test) return false;
      if (r.absent === true || r.score === 0) return false;
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
      // subjectName stays the grouping key for the per-subject trend lines
      // (Middle/Matric/Inter must remain separate). subjectDisplay is the
      // simplified label for the results table only — never used to group.
      subjectName: r.test.subject ? r.test.subject.name : "Unknown",
      subjectDisplay: r.test.subject ? (r.test.subject.displayName || r.test.subject.name) : "Unknown",
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
      .populate("subject", "name displayName")
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
      // Absent pupils (blank mark, stored as score 0 + absent) must not drag a
      // class-average trend line down — they are excluded from the bucket.
      if (r.absent === true || r.score === 0) return;
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
  const {
    classLevel, grade, subject, testId, sessionId, phase, week, fromDate, toDate,
  } = filters;

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
      classes, subjects, sessions, testSnapshot: [],
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
    // Batch-resolve every "grade:<level>" token in ONE query instead of a
    // ClassLevel.find per grade token.  Results are grouped by grade so the
    // original token order can still be walked below to reproduce the exact
    // fail-fast, per-token rejection (which grade/class is named in the 403).
    const gradeTokensInOrder = classTokens
      .filter((t) => t.startsWith("grade:"))
      .map((t) => t.slice("grade:".length));
    const byGrade = {};
    if (gradeTokensInOrder.length > 0) {
      const gradeDocs = await ClassLevel.find({
        _id: { $in: teacherClassLevelIds },
        gradeLevel: { $in: [...new Set(gradeTokensInOrder)] },
      })
        .select("_id gradeLevel")
        .lean();
      gradeDocs.forEach((d) => {
        const g = String(d.gradeLevel);
        (byGrade[g] = byGrade[g] || []).push(d._id.toString());
      });
    }
    // Walk the tokens in their ORIGINAL order so the first out-of-scope token
    // decides the response, exactly as the previous per-token loop did.
    for (const token of classTokens) {
      if (token.startsWith("grade:")) {
        const gradeVal = token.slice("grade:".length);
        const gradeIds = byGrade[gradeVal] || [];
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
  // Grade dropdown (cascade filter): one grade level → every one of the
  // teacher's sections in that grade. Combines with any classLevel tokens.
  if (grade) {
    const gradeDocs = await ClassLevel.find({
      _id: { $in: teacherClassLevelIds },
      gradeLevel: grade,
    }).select("_id").lean();
    const gradeIds = gradeDocs.map((d) => d._id.toString());
    if (gradeIds.length === 0) {
      return responseStatus(res, 403, "failed", "You are not assigned to any class in grade " + grade);
    }
    classFilterIds = classFilterIds
      ? [...new Set([...classFilterIds, ...gradeIds])]
      : gradeIds;
  }
  if (subject && !teacherSubjectIds.includes(subject)) {
    return responseStatus(res, 403, "failed", "You are not assigned to this subject");
  }

  // 3. Build test query scoped to teacher's subjects and classes
  const testQuery = { subject: { $in: teacherSubjectIds } };
  if (classFilterIds) testQuery.classLevels = { $in: classFilterIds };
  if (subject) testQuery.subject = subject;
  if (sessionId) testQuery.session = sessionId;
  if (phase) testQuery.phase = phase;
  if (week) testQuery.week = week;
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
    .populate("subject", "name displayName")
    .populate("classLevels", "name")
    .populate("session", "name")
    .populate("week", "name")
    .sort({ date: -1 })
    .lean();

  // Keep only tests where the teacher covers at least one of the test's classes
  const isTeacherScoped = (t) => {
    const subId = t.subject && t.subject._id ? t.subject._id.toString() : t.subject.toString();
    const classSet = subjectClassMap[subId];
    if (!classSet) return false;
    return (t.classLevels || []).some((cl) => {
      const clId = cl._id ? cl._id.toString() : cl.toString();
      return classSet.has(clId);
    });
  };
  const scopedTests = tests.filter(isTeacherScoped);

  // 5b. Cascade dropdown snapshot — EVERY test the teacher is scoped to, with
  //     no UI filters applied. The view renders the six dropdowns from this,
  //     so each level only ever offers options that actually contain one of
  //     the teacher's tests. Only re-queried when a filter is active (the
  //     `tests` result above is already narrowed in that case).
  const hasUiFilters = !!(classLevel || grade || subject || sessionId || phase || week || testId || fromDate || toDate);
  let snapshotTests = tests;
  if (hasUiFilters) {
    snapshotTests = await Test.find({ subject: { $in: teacherSubjectIds } })
      .populate("subject", "name displayName")
      .populate("classLevels", "name")
      .populate("session", "name")
      .populate("week", "name")
      .sort({ date: -1 })
      .lean();
  }
  const classIdToGrade = {};
  classes.forEach((c) => {
    if (c.gradeLevel != null) classIdToGrade[c._id.toString()] = String(c.gradeLevel);
  });
  const testSnapshot = snapshotTests.filter(isTeacherScoped).map((t) => {
    const refId = (v) => (v ? (v._id ? v._id.toString() : v.toString()) : "");
    return {
      _id: t._id.toString(),
      name: t.name,
      subjectId: refId(t.subject),
      subjectName: (t.subject && (t.subject.displayName || t.subject.name)) || "",
      session: refId(t.session),
      phase: refId(t.phase),
      week: refId(t.week),
      weekName: (t.week && t.week.name) || "",
      // Grade levels behind the test's classes, limited to the teacher's own
      // classes so the Grade dropdown never offers an out-of-scope level.
      grades: [
        ...new Set(
          (t.classLevels || [])
            .map((cl) => classIdToGrade[cl._id ? cl._id.toString() : cl.toString()])
            .filter(Boolean),
        ),
      ],
    };
  });

  if (scopedTests.length === 0) {
    return responseStatus(res, 200, "success", {
      classes, subjects, sessions, testSnapshot,
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
    classes, subjects, sessions, testSnapshot,
    perClass, perSession, overallStats,
  });
};

/**
 * Delete a test (admin/manager). Cascades to the test's submitted scores.
 *
 * Audited and fail-closed: the deletion, the removal of every TestResult and
 * the append-only audit row run inside a single MongoDB transaction (mirroring
 * the fee soft-delete guarantee). If the audit row cannot be written, the whole
 * operation aborts and NOTHING is deleted — so a manager-deleted test that had
 * submitted scores is always traceable (who, when, what, how many scores lost).
 *
 * @param {string} testId
 * @param {string} actorId – verified token id of the admin/manager (resolved to
 *                           a DB identity for the audit; never taken from a role
 *                           claim on the request).
 */
exports.deleteTestService = async (testId, actorId, res) => {
  if (!actorId) throw new Error("Test deletion requires an actor — refusing unattributed delete");

  // Pre-image with human-readable subject/class names so the audit trail is
  // self-describing even after the documents are gone.
  const test = await Test.findById(testId)
    .populate("subject", "name displayName")
    .populate("classLevels", "name");
  if (!test) return responseStatus(res, 404, "failed", "Test not found");

  const actor = await resolveAuditActor(actorId);

  const snapshot = {
    name: test.name,
    subject: test.subject ? test.subject.name || test.subject._id : null,
    classLevels: (test.classLevels || []).map((c) => c.name || c._id),
    session: test.session || null,
    phase: test.phase || null,
    week: test.week || null,
    date: test.date || null,
    totalMarks: test.totalMarks,
    passMarks: test.passMarks,
    createdBy: test.createdBy || null,
  };

  const resultsRemoved = await TestResult.countDocuments({ test: testId });

  await withTransaction(async ({ session }) => {
    const opts = session ? { session } : {};
    // Audit FIRST and inside the same transaction as the deletes: a failure to
    // record the action rolls the deletion back (fail-closed), never the
    // reverse.
    await TestAudit.create(
      [
        {
          action: "delete",
          test: test._id,
          actor: actorId,
          actorName: actor.actorName,
          actorRole: actor.actorRole,
          snapshot,
          resultsRemoved,
          note: "Test deleted (scores cascade-removed)",
        },
      ],
      opts
    );
    await TestResult.deleteMany({ test: testId }, opts);
    await Test.deleteOne({ _id: testId }, opts);
  });

  return responseStatus(res, 200, "success", {
    test: test.name,
    deletedResults: resultsRemoved,
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

  const tests = await Test.find({ session: sessionId }).populate("subject", "name displayName");
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
          // Display label; phase grouping above keys off phase ids, not this.
          subject: t.subject ? (t.subject.displayName || t.subject.name) : "Unknown",
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
