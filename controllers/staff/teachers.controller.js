const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createTeacherService,
  teacherLoginService,
  getAllTeachersService,
  getTeacherProfileService,
  updateTeacherProfileService,
  adminUpdateTeacherProfileService,
  adminUpdateCredentialsService,
  adminGetTeacherService,
  deleteTeacherService,
} = require("../../services/staff/teachers.service");

/**
 * @desc Admin create teacher
 * @route POST /api/v1/create-teacher
 * @access Private (admin)
 **/
exports.createTeacherController = async (req, res) => {
  try {
    await createTeacherService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * @desc Teacher login
 * @route POST /api/v1/teacher/login
 * @access Public
 **/
exports.teacherLoginController = async (req, res) => {
  try {
    await teacherLoginService(req.body, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * @desc Get all teachers
 * @route GET /api/v1/teachers
 * @access Private (admin)
 **/
exports.getAllTeachersController = async (req, res) => {
  try {
    const result = await getAllTeachersService(req.query);
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * @desc Get teacher profile
 * @route GET /api/v1/teacher/profile
 * @access Private (teacher)
 **/
exports.getTeacherProfileController = async (req, res) => {
  try {
    const result = await getTeacherProfileService(req.userAuth.id);
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * @desc Update teacher profile
 * @route PATCH /api/v1/teacher/update-profile
 * @access Private (Teacher)
 **/
exports.updateTeacherProfileController = async (req, res) => {
  try {
    const result = await updateTeacherProfileService(
      req.body,
      req.userAuth.id,
      res
    );
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * @desc Admin update teacher profile
 * @route PATCH /api/v1/teacher/:teachersId/update-profile
 * @access Private (Admin)
 **/
exports.adminUpdateTeacherProfileController = async (req, res) => {
  try {
    await adminUpdateTeacherProfileService(req.body, req.params.teacherId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * @desc Admin toggles a teacher's attendance-manager flag
 * @route PATCH /api/v1/teacher/:teacherId/toggle-attendance-manager
 * @access Private (Admin)
 **/
exports.toggleAttendanceManagerController = async (req, res) => {
  try {
    const { toggleAttendanceManagerService } = require("../../services/staff/teachers.service");
    await toggleAttendanceManagerService(req.params.teacherId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * @desc Admin update teacher credentials (name/email/password)
 * @route PUT /api/v1/teacher/:teacherId/credentials
 * @access Private (Admin)
 **/
exports.adminUpdateCredentialsController = async (req, res) => {
  try {
    await adminUpdateCredentialsService(req.body, req.params.teacherId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * @desc Admin deletes a teacher
 * @route DELETE /api/v1/teacher/:teacherId
 * @access Private (Admin)
 **/
exports.deleteTeacherController = async (req, res) => {
  try {
    await deleteTeacherService(req.params.teacherId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

/**
 * @desc Admin get a teacher by ID
 * @route GET /api/v1/admin/teacher/:teacherId
 * @access Private (Admin)
 **/
exports.adminGetTeacherController = async (req, res) => {
  try {
    const result = await adminGetTeacherService(req.params.teacherId);
    if (!result) return responseStatus(res, 404, "failed", "Teacher not found");
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
