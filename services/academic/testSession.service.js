const responseStatus = require("../../handlers/responseStatus.handler");
const TestSession = require("../../models/Academic/testSession.model");
const Week = require("../../models/Academic/week.model");
const Test = require("../../models/Academic/test.model");

exports.createTestSessionService = async (data, adminId, res) => {
  const { name, classLevels, phases } = data;

  if (!phases || phases.length === 0) {
    return responseStatus(res, 400, "failed", "A session needs at least one phase");
  }

  const orderedPhases = phases.map((p, i) => ({ name: p.name, order: p.order ?? i + 1 }));

  const session = await TestSession.create({
    name,
    classLevels,
    phases: orderedPhases,
    createdBy: adminId,
  });

  return responseStatus(res, 201, "success", session);
};

exports.getAllTestSessionsService = async (res) => {
  const sessions = await TestSession.find({}).populate("classLevels", "name");
  return responseStatus(res, 200, "success", sessions);
};

exports.getTestSessionByIdService = async (sessionId, res) => {
  const session = await TestSession.findById(sessionId).populate("classLevels", "name");
  if (!session) return responseStatus(res, 404, "failed", "Session not found");
  return responseStatus(res, 200, "success", session);
};

/**
 * Delete a test session and cascade-unlink all dependents.
 * Strategy (matches the existing Week-deletion pattern):
 *   - Unlink tests → set week/session/phase to null (never delete test data)
 *   - Delete all Week documents belonging to this session
 *   - Delete the TestSession itself
 */
exports.deleteTestSessionService = async (sessionId, res) => {
  const session = await TestSession.findById(sessionId);
  if (!session) return responseStatus(res, 404, "failed", "Session not found");

  // Collect week IDs for this session so we can unlink their tests
  const weekIds = await Week.find({ session: sessionId }).distinct("_id");

  // Unlink tests that reference any of these weeks
  if (weekIds.length > 0) {
    await Test.updateMany({ week: { $in: weekIds } }, { $set: { week: null } });
  }

  // Unlink tests that reference this session directly
  await Test.updateMany(
    { session: sessionId },
    { $set: { session: null, phase: null, week: null } }
  );

  // Remove all weeks belonging to this session
  await Week.deleteMany({ session: sessionId });

  // Delete the session itself
  await TestSession.findByIdAndDelete(sessionId);

  return responseStatus(res, 200, "success", "Session and its weeks deleted; linked tests unassigned.");
};

/**
 * Remove a single phase from a session and cascade-unlink dependents.
 * Strategy (matches the existing Week-deletion pattern):
 *   - Unlink tests referencing weeks in this phase → week = null
 *   - Unlink tests referencing this phase directly → session/phase/week = null
 *   - Delete Week documents in this phase
 *   - Pull the phase subdocument from the session
 */
exports.deletePhaseService = async (sessionId, phaseId, res) => {
  const session = await TestSession.findById(sessionId);
  if (!session) return responseStatus(res, 404, "failed", "Session not found");

  const phaseExists = session.phases.some((p) => p._id.toString() === phaseId);
  if (!phaseExists) return responseStatus(res, 404, "failed", "Phase not found in this session");

  // Collect week IDs for this phase
  const weekIds = await Week.find({ session: sessionId, phase: phaseId }).distinct("_id");

  // Unlink tests referencing these weeks
  if (weekIds.length > 0) {
    await Test.updateMany({ week: { $in: weekIds } }, { $set: { week: null } });
  }

  // Unlink tests referencing this phase directly
  await Test.updateMany(
    { session: sessionId, phase: phaseId },
    { $set: { session: null, phase: null, week: null } }
  );

  // Delete weeks in this phase
  await Week.deleteMany({ session: sessionId, phase: phaseId });

  // Remove the phase subdocument from the session
  await TestSession.findByIdAndUpdate(sessionId, {
    $pull: { phases: { _id: phaseId } },
  });

  return responseStatus(res, 200, "success", "Phase and its weeks deleted; linked tests unassigned.");
};
