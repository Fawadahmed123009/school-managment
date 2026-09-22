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
 * Cascade-unlink and delete all dependents of a single phase
 * (weeks + test links). Shared by deletePhaseService and the session editor.
 */
const purgePhaseDependents = async (sessionId, phaseId) => {
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

  await purgePhaseDependents(sessionId, phaseId);

  // Remove the phase subdocument from the session
  await TestSession.findByIdAndUpdate(sessionId, {
    $pull: { phases: { _id: phaseId } },
  });

  return responseStatus(res, 200, "success", "Phase and its weeks deleted; linked tests unassigned.");
};

/**
 * Edit a session: rename it, replace its classLevels, and edit its phases.
 * The phase document handles ID reuse automatically:
 *   - phase WITHOUT _id  → new phase (add)
 *   - phase WITH _id     → existing phase, fields applied in place (rename/reorder)
 *   - existing phase absent from the array → cascade-purged (weeks deleted, tests unlinked)
 * The session must keep at least one phase.
 */
exports.updateTestSessionService = async (sessionId, data, res) => {
  const { name, classLevels, phases } = data;

  const session = await TestSession.findById(sessionId);
  if (!session) return responseStatus(res, 404, "failed", "Session not found");

  if (!Array.isArray(phases) || phases.length === 0) {
    return responseStatus(res, 400, "failed", "A session needs at least one phase");
  }

  const cleaned = phases
    .map((p, i) => {
      const phase = {
        name: (p.name || "").trim(),
        order: Number.isFinite(Number(p.order)) ? Number(p.order) : i + 1,
      };
      // Reuse the existing subdoc _id when provided; omit it for new phases
      // so Mongoose auto-generates one.
      if (p._id) phase._id = p._id;
      return phase;
    })
    .filter((p) => p.name);
  if (cleaned.length === 0) {
    return responseStatus(res, 400, "failed", "Every phase needs a name");
  }

  // Purge dependents of phases being removed
  const keptIds = cleaned.filter((p) => p._id).map((p) => p._id.toString());
  const removedIds = session.phases
    .filter((p) => !keptIds.includes(p._id.toString()))
    .map((p) => p._id.toString());
  for (const phaseId of removedIds) {
    await purgePhaseDependents(sessionId, phaseId);
  }

  if (typeof name === "string" && name.trim()) session.name = name.trim();
  if (Array.isArray(classLevels)) session.classLevels = classLevels;
  session.phases = cleaned;
  await session.save();

  return responseStatus(res, 200, "success", session);
};

/**
 * Append a new phase to a session (kept for programmatic/API use).
 */
exports.addPhaseService = async (sessionId, phaseName, res) => {
  const name = (phaseName || "").trim();
  if (!name) return responseStatus(res, 400, "failed", "Phase name is required");

  const session = await TestSession.findById(sessionId);
  if (!session) return responseStatus(res, 404, "failed", "Session not found");

  const nextOrder = session.phases.reduce((max, p) => Math.max(max, p.order || 0), 0) + 1;
  session.phases.push({ name, order: nextOrder });
  await session.save();

  return responseStatus(res, 201, "success", session);
};
