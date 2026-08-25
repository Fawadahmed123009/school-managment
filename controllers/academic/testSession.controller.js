const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createTestSessionService,
  getAllTestSessionsService,
  getTestSessionByIdService,
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
