const responseStatus = require("../../handlers/responseStatus.handler");
const { extractFeesFromImageService } = require("../../services/fees/ocr.service");

exports.extractFeesFromImageController = async (req, res) => {
  try {
    if (!req.file) {
      return responseStatus(res, 400, "failed", "No image uploaded");
    }
    await extractFeesFromImageService(req.file.path, req.file.mimetype, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
