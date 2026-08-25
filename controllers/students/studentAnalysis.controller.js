const responseStatus = require("../../handlers/responseStatus.handler");
const { getStudentAnalysisService } = require("../../services/students/studentAnalysis.service");

exports.getStudentAnalysisController = async (req, res) => {
  try {
    await getStudentAnalysisService(req.params.studentId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
