const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createWeekService,
  getWeeksForSessionService,
  getWeekByIdService,
  getWeeksForPhaseService,
  updateWeekService,
  deleteWeekService,
} = require("../../services/academic/week.service");

exports.createWeekController = async (req, res) => {
  try {
    await createWeekService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getWeeksForSessionController = async (req, res) => {
  try {
    const result = await getWeeksForSessionService(req.params.sessionId);
    if (!result) return responseStatus(res, 404, "failed", "Session not found");
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getWeekByIdController = async (req, res) => {
  try {
    const result = await getWeekByIdService(req.params.weekId);
    if (!result) return responseStatus(res, 404, "failed", "Week not found");
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getWeeksForPhaseController = async (req, res) => {
  try {
    const result = await getWeeksForPhaseService(req.params.sessionId, req.params.phaseId);
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.updateWeekController = async (req, res) => {
  try {
    await updateWeekService(req.body, req.params.weekId, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.deleteWeekController = async (req, res) => {
  try {
    await deleteWeekService(req.params.weekId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
