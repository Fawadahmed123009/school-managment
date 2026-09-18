const Week = require("../../models/Academic/week.model");
const TestSession = require("../../models/Academic/testSession.model");
const Test = require("../../models/Academic/test.model");
const responseStatus = require("../../handlers/responseStatus.handler");

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
