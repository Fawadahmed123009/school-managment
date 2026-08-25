const responseStatus = require("../../handlers/responseStatus.handler");
const TestSession = require("../../models/Academic/testSession.model");

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
