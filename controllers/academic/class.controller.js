const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createClassLevelService,
  getAllClassesService,
  getClassLevelsService,
  deleteClassLevelService,
  updateClassLevelService,
} = require("../../services/academic/class.service");

exports.createClassLevelController = async (req, res) => {
  try {
    await createClassLevelService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getClassLevelsController = async (req, res) => {
  try {
    const result = await getAllClassesService();
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getClassLevelController = async (req, res) => {
  try {
    const result = await getClassLevelsService(req.params.classLevelId);
    if (!result) return responseStatus(res, 404, "failed", "Class not found");
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.updateClassLevelController = async (req, res) => {
  try {
    await updateClassLevelService(req.body, req.params.classLevelId, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.deleteClassLevelController = async (req, res) => {
  try {
    await deleteClassLevelService(req.params.classLevelId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
