const responseStatus = require("../../handlers/responseStatus.handler");
const { setStudentPhotoService } = require("../../services/students/studentPhoto.service");

exports.setStudentPhotoController = async (req, res) => {
  try {
    await setStudentPhotoService(req.params.studentId, req.file, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
