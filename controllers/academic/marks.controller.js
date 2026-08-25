const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createMarkService,
  bulkCreateMarksService,
  getStudentTermReportService,
} = require("../../services/academic/marks.service");

exports.createMarkController = async (req, res) => {
  try {
    await createMarkService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.bulkCreateMarksController = async (req, res) => {
  try {
    await bulkCreateMarksService(req.body.marks, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getStudentTermReportController = async (req, res) => {
  try {
    await getStudentTermReportService(req.params.studentId, req.params.academicTermId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
