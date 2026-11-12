const responseStatus = require("../../handlers/responseStatus.handler");
const {
  getTeacherPayConfigsService,
  createTeacherPayConfigService,
  getTeacherSalarySettingsService,
  updateTeacherSalarySettingsService,
  previewTeacherSalaryService,
  generateTeacherSalaryService,
  getTeacherSalaryRunsService,
  getTeacherSalaryRunService,
  finalizeTeacherSalaryRunService,
  deleteTeacherSalaryRunService,
} = require("../../services/staff/teacherSalary.service");

// Every controller here sits behind isLoggedIn + isAdmin at the router —
// salary is ADMIN ONLY (managers never see pay rates, amounts or runs).

// Active teachers + current rate + insert-only rate history + hasConfig flag.
exports.getTeacherPayConfigsController = async (req, res) => {
  try {
    await getTeacherPayConfigsService(res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Insert a NEW rate row (rate history is never overwritten).
exports.createTeacherPayConfigController = async (req, res) => {
  try {
    const { teacher, payType, rateAmount, effectiveFrom } = req.body;
    await createTeacherPayConfigService({ teacher, payType, rateAmount, effectiveFrom }, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Deduction rule read.
exports.getTeacherSalarySettingsController = async (req, res) => {
  try {
    await getTeacherSalarySettingsService(res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Deduction rule write. Form bodies arrive as strings, so normalize the
// checkbox here before validation (same pattern as the Phase 1 settings).
exports.updateTeacherSalarySettingsController = async (req, res) => {
  try {
    const raw = req.body.lateDeductionEnabled;
    const payload = {
      lateDeductionEnabled: raw === true || raw === "true" || raw === "on" || raw === "1",
      deductionType: req.body.deductionType,
      flatAmount: req.body.flatAmount,
      percentValue: req.body.percentValue,
    };
    await updateTeacherSalarySettingsService(payload, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Dry run — full calculation, zero writes.
exports.previewTeacherSalaryController = async (req, res) => {
  try {
    const { teacherId, startDate, endDate, lectureCount } = req.body;
    await previewTeacherSalaryService({ teacherId, startDate, endDate, lectureCount }, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Generate a draft run (server-side recompute; replaces the same-period draft).
exports.generateTeacherSalaryController = async (req, res) => {
  try {
    const { teacherId, startDate, endDate, lectureCount } = req.body;
    await generateTeacherSalaryService({ teacherId, startDate, endDate, lectureCount }, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Run history (teacher/status filters, paged).
exports.getTeacherSalaryRunsController = async (req, res) => {
  try {
    const filters = {
      teacherId: req.query.teacherId || "",
      status: req.query.status || "",
      page: req.query.page,
      limit: req.query.limit,
    };
    await getTeacherSalaryRunsService(filters, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// One run with its full snapshot (segments, day-wise rows, deduction rule).
exports.getTeacherSalaryRunController = async (req, res) => {
  try {
    await getTeacherSalaryRunService(req.params.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Lock a draft → finalized (immutable afterwards).
exports.finalizeTeacherSalaryRunController = async (req, res) => {
  try {
    await finalizeTeacherSalaryRunService(req.params.id, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

// Delete a draft only.
exports.deleteTeacherSalaryRunController = async (req, res) => {
  try {
    await deleteTeacherSalaryRunService(req.params.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};