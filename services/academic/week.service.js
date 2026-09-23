const Week = require("../../models/Academic/week.model");
const TestSession = require("../../models/Academic/testSession.model");
const Test = require("../../models/Academic/test.model");
const responseStatus = require("../../handlers/responseStatus.handler");

const DAY_MS = 24 * 60 * 60 * 1000;

// Add an integer number of days to a date, returning a new Date. We compute in
// UTC terms so a test's time-of-day is preserved while the calendar date shifts
// by exactly the requested offset (independent of the server's timezone).
function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Whole-day offset between a source week's start and the new week's start.
function shiftDaysBetween(sourceStartDate, newStartDate) {
  const src = new Date(sourceStartDate);
  const tgt = new Date(newStartDate);
  return Math.round((Date.UTC(tgt.getFullYear(), tgt.getMonth(), tgt.getDate())
    - Date.UTC(src.getFullYear(), src.getMonth(), src.getDate())) / DAY_MS);
}

exports.createWeekService = async (data, userId, res) => {
  const { name, session, phase, startDate, endDate } = data;

  if (!name || !session || !phase || !startDate || !endDate) {
    return responseStatus(res, 400, "failed", "Name, session, phase, start date, and end date are required");
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end < start) {
    return responseStatus(res, 400, "failed", "End date must be on or after start date");
  }

  const sessionDoc = await TestSession.findById(session);
  if (!sessionDoc) {
    return responseStatus(res, 404, "failed", "Session not found");
  }

  const phaseExists = sessionDoc.phases.some((p) => p._id.toString() === phase);
  if (!phaseExists) {
    return responseStatus(res, 400, "failed", "Phase not found in this session");
  }

  const week = await Week.create({
    name,
    session,
    phase,
    startDate: start,
    endDate: end,
    createdBy: userId,
  });

  return responseStatus(res, 201, "success", week);
};

exports.getWeeksForSessionService = async (sessionId) => {
  const session = await TestSession.findById(sessionId).lean();
  if (!session) return null;

  const weeks = await Week.find({ session: sessionId })
    .sort({ startDate: 1 })
    .lean();

  // Build a phase-id → phase-name lookup from the embedded phases
  const phaseNameMap = {};
  session.phases.forEach((p) => {
    phaseNameMap[p._id.toString()] = p.name;
  });

  // Attach test counts per week
  const testCounts = await Test.aggregate([
    { $match: { week: { $exists: true, $ne: null } } },
    { $group: { _id: "$week", count: { $sum: 1 } } },
  ]);
  const countById = new Map(testCounts.map((c) => [String(c._id), c.count]));

  return {
    session,
    weeks: weeks.map((w) => ({
      ...w,
      phaseName: phaseNameMap[String(w.phase)] || "Unknown",
      testCount: countById.get(String(w._id)) || 0,
    })),
  };
};

exports.getWeekByIdService = async (id) => {
  return await Week.findById(id).populate("session", "name");
};

exports.getWeeksForPhaseService = async (sessionId, phaseId) => {
  return await Week.find({ session: sessionId, phase: phaseId })
    .sort({ startDate: 1 })
    .lean();
};

exports.updateWeekService = async (data, id, userId, res) => {
  const { name, session, phase, startDate, endDate } = data;

  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (end < start) {
      return responseStatus(res, 400, "failed", "End date must be on or after start date");
    }
  }

  if (session && phase) {
    const sessionDoc = await TestSession.findById(session);
    if (!sessionDoc) {
      return responseStatus(res, 404, "failed", "Session not found");
    }
    const phaseExists = sessionDoc.phases.some((p) => p._id.toString() === phase);
    if (!phaseExists) {
      return responseStatus(res, 400, "failed", "Phase not found in this session");
    }
  }

  const update = {};
  if (name !== undefined) update.name = name;
  if (session !== undefined) update.session = session;
  if (phase !== undefined) update.phase = phase;
  if (startDate !== undefined) update.startDate = new Date(startDate);
  if (endDate !== undefined) update.endDate = new Date(endDate);

  const week = await Week.findByIdAndUpdate(id, update, { new: true });
  if (!week) return responseStatus(res, 404, "failed", "Week not found");

  return responseStatus(res, 200, "success", week);
};

exports.deleteWeekService = async (id, res) => {
  const week = await Week.findById(id);
  if (!week) return responseStatus(res, 404, "failed", "Week not found");

  // Unlink any tests referencing this week (set week to null)
  await Test.updateMany({ week: id }, { $set: { week: null } });

  await Week.findByIdAndDelete(id);
  return responseStatus(res, 200, "success", "Week deleted");
};

// ── Clone a week's tests into a brand-new week ─────────────────────────────
//
// The flow mirrors the bulk class-promotion safety pattern: a preview is built
// server-side (never trusting the client for the source data) and shown to the
// admin; only after confirmation do we actually create anything.

// Fetch the tests belonging to a week, populated for display.
async function loadSourceTests(sourceWeekId) {
  return await Test.find({ week: sourceWeekId })
    .populate("subject", "name")
    .populate("classLevels", "name")
    .sort({ date: 1 })
    .lean();
}

// Fetch the source week + its tests so the clone form can show what will be
// cloned (and whether there is anything to clone at all).
exports.getCloneFormContextService = async (sourceWeekId) => {
  const sourceWeek = await Week.findById(sourceWeekId).lean();
  if (!sourceWeek) return null;
  const tests = await loadSourceTests(sourceWeekId);
  return {
    sourceWeek: {
      _id: String(sourceWeek._id),
      name: sourceWeek.name,
      startDate: new Date(sourceWeek.startDate),
      endDate: new Date(sourceWeek.endDate),
      session: String(sourceWeek.session),
      phase: String(sourceWeek.phase),
    },
    tests,
  };
};

// Build a validated preview of what cloning would produce.
// Returns { error } on a validation failure, or a preview object on success.
exports.buildCloneWeekPreviewService = async (sourceWeekId, details) => {
  const sourceWeek = await Week.findById(sourceWeekId).lean();
  if (!sourceWeek) return { error: "Source week not found" };

  const name = (details.name || "").trim();
  const startDate = details.startDate;
  const endDate = details.endDate;
  if (!name || !startDate || !endDate) {
    return { error: "New week name, start date, and end date are required" };
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { error: "Invalid start or end date" };
  }
  if (end < start) {
    return { error: "End date must be on or after start date" };
  }

  const tests = await loadSourceTests(sourceWeekId);
  if (tests.length === 0) {
    return { error: "NO_TESTS" };
  }

  const shiftDays = shiftDaysBetween(sourceWeek.startDate, start);

  const clonedTests = tests.map((t) => {
    const originalDate = new Date(t.date);
    const newDate = addDays(originalDate, shiftDays);
    return {
      _id: String(t._id),
      name: t.name,
      subjectName: t.subject ? t.subject.name : "—",
      classLevelNames: (t.classLevels || []).map((c) => c.name).join(", ") || "—",
      totalMarks: t.totalMarks,
      passMarks: t.passMarks,
      originalDate,
      newDate,
    };
  });

  return {
    sourceWeek: {
      _id: String(sourceWeek._id),
      name: sourceWeek.name,
      startDate: new Date(sourceWeek.startDate),
      endDate: new Date(sourceWeek.endDate),
      session: String(sourceWeek.session),
      phase: String(sourceWeek.phase),
    },
    newWeek: { name, startDate: start, endDate: end },
    shiftDays,
    tests: clonedTests,
  };
};

// Execute the clone: create the new week and duplicate every source test into
// it with shifted dates. Cloned tests carry no scores/submissions — just the
// test definition (name, subject, classLevels, marks, session, phase).
exports.executeCloneWeekService = async (sourceWeekId, details, userId) => {
  const sourceWeek = await Week.findById(sourceWeekId);
  if (!sourceWeek) throw new Error("Source week not found");

  const name = (details.name || "").trim();
  const start = new Date(details.startDate);
  const end = new Date(details.endDate);
  if (!name || isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error("New week details are invalid");
  }
  if (end < start) throw new Error("End date must be on or after start date");

  const tests = await loadSourceTests(sourceWeekId);
  if (tests.length === 0) throw new Error("Source week has no tests to clone");

  const shiftDays = shiftDaysBetween(sourceWeek.startDate, start);

  const newWeek = await Week.create({
    name,
    session: sourceWeek.session,
    phase: sourceWeek.phase,
    startDate: start,
    endDate: end,
    createdBy: userId,
  });

  const created = await Test.insertMany(
    tests.map((t) => ({
      name: t.name,
      subject: t.subject ? t.subject._id : null,
      classLevels: (t.classLevels || []).map((c) => c._id),
      date: addDays(new Date(t.date), shiftDays),
      totalMarks: t.totalMarks,
      passMarks: t.passMarks,
      week: newWeek._id,
      session: t.session || sourceWeek.session,
      phase: t.phase || sourceWeek.phase,
      createdBy: userId,
    }))
  );

  return { week: newWeek, testsCreated: created.length };
};
