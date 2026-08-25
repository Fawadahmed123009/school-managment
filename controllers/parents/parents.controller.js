const responseStatus = require("../../handlers/responseStatus.handler");
const {
  parentLoginService,
  getParentProfileService,
  getChildrenAnalysisService,
  getChildrenFeesService,
  createParentService,
  getAllParentsService,
  addChildToParentService,
} = require("../../services/parents/parents.service");

exports.parentLoginController = async (req, res) => {
  try {
    await parentLoginService(req.body, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getParentProfileController = async (req, res) => {
  try {
    await getParentProfileService(req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getChildrenAnalysisController = async (req, res) => {
  try {
    await getChildrenAnalysisService(req.userAuth.id, req.params.childId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getChildrenFeesController = async (req, res) => {
  try {
    await getChildrenFeesService(req.userAuth.id, req.params.childId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.createParentController = async (req, res) => {
  try {
    await createParentService(req.body, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAllParentsController = async (req, res) => {
  try {
    const result = await getAllParentsService(req.query);
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.addChildToParentController = async (req, res) => {
  try {
    await addChildToParentService(req.params.parentId, req.params.childId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
