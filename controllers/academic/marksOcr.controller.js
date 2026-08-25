const responseStatus = require("../../handlers/responseStatus.handler");
const { extractMarksFromImageService } = require("../../services/academic/marksOcr.service");

exports.extractMarksFromImageController = async (req, res) => {
  try {
    if (!req.file) {
      return responseStatus(res, 400, "failed", "No image uploaded");
    }
    await extractMarksFromImageService(req.file.path, req.file.mimetype, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
