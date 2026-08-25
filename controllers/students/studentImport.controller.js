const responseStatus = require("../../handlers/responseStatus.handler");
const {
  parseStudentExcelService,
  bulkCreateStudentsFromImportService,
  exportStudentsService,
} = require("../../services/students/studentImport.service");

exports.parseStudentExcelController = async (req, res) => {
  try {
    if (!req.file) {
      return responseStatus(res, 400, "failed", "No file uploaded");
    }
    await parseStudentExcelService(req.file.path, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.bulkCreateStudentsFromImportController = async (req, res) => {
  try {
    await bulkCreateStudentsFromImportService(req.body.students, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.exportStudentsController = async (req, res) => {
  try {
    await exportStudentsService(res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
