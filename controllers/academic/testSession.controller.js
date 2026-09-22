const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createTestSessionService,
  getAllTestSessionsService,
  getTestSessionByIdService,
  deleteTestSessionService,
  deletePhaseService,
  updateTestSessionService,
  addPhaseService,
} = require("../../services/academic/testSession.service");

exports.createTestSessionController = async (req, res) => {
  try {
    await createTestSessionService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAllTestSessionsController = async (req, res) => {
  try {
    await getAllTestSessionsService(res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getTestSessionByIdController = async (req, res) => {
  try {
    await getTestSessionByIdService(req.params.sessionId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.deleteTestSessionController = async (req, res) => {
  try {
    await deleteTestSessionService(req.params.sessionId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.deletePhaseController = async (req, res) => {
  try {
    await deletePhaseService(req.params.sessionId, req.params.phaseId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.updateTestSessionController = async (req, res) => {
  try {
    await updateTestSessionService(req.params.sessionId, req.body, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.addPhaseController = async (req, res) => {
  try {
    await addPhaseService(req.params.sessionId, req.body.name, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
