const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createSectionService,
  getAllSectionsService,
  getSectionService,
  updateSectionService,
  toggleSectionActiveService,
  deleteSectionService,
} = require("../../services/academic/section.service");

exports.createSectionController = async (req, res) => {
  try {
    await createSectionService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getSectionsController = async (req, res) => {
  try {
    const result = await getAllSectionsService();
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getSectionController = async (req, res) => {
  try {
    const result = await getSectionService(req.params.sectionId);
    if (!result) return responseStatus(res, 404, "failed", "Section not found");
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.updateSectionController = async (req, res) => {
  try {
    await updateSectionService(req.body, req.params.sectionId, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.toggleSectionActiveController = async (req, res) => {
  try {
    await toggleSectionActiveService(req.params.sectionId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.deleteSectionController = async (req, res) => {
  try {
    await deleteSectionService(req.params.sectionId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
