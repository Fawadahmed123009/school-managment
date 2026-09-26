const express = require("express");
const { makeUpload, cleanupUploadedFiles } = require("../../../utils/uploadFactory");
const feesRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");

const {
  createFeeController,
  bulkCreateFeesController,
  bulkAssignFeesController,
  generateMonthlyFeesController,
  getAllFeesController,
  getStudentFeesController,
  updateFeeController,
  deleteFeeController,
  getFeeAuditController,
  resolveOcrReviewController,
} = require("../../../controllers/fees/fees.controller");

const { extractFeesFromImageController } = require("../../../controllers/fees/ocr.controller");

const {
  createFeeHeadController,
  getAllFeeHeadsController,
  updateFeeHeadController,
  deleteFeeHeadController,
  getDailyCollectionController,
  getDefaulterListController,
} = require("../../../controllers/fees/feeHead.controller");

// H5: fee-scan images go through the shared hardened upload (8 MB cap, one
// file, image type filter) and the temp copy is removed when the response ends,
// not only when the OCR path succeeds. See utils/uploadFactory.js.
const upload = makeUpload("image");

// ---- Fee records ----
feesRouter.route("/fees").post(isLoggedIn, isAdmin, createFeeController);
feesRouter.route("/fees").get(isLoggedIn, isAdmin, getAllFeesController);
feesRouter.route("/fees/bulk").post(isLoggedIn, isAdmin, bulkCreateFeesController);
feesRouter.route("/fees/bulk-assign").post(isLoggedIn, isAdmin, bulkAssignFeesController);
feesRouter.route("/fees/generate-monthly").post(isLoggedIn, isAdmin, generateMonthlyFeesController);
feesRouter.route("/fees/ocr/resolve/:feeId").post(isLoggedIn, isAdmin, resolveOcrReviewController);
// Fee audit trail (C2) — append-only record of who created/edited/deleted what.
feesRouter.route("/fees/audit").get(isLoggedIn, isAdmin, getFeeAuditController);
feesRouter.route("/fees/student/:studentId").get(isLoggedIn, isAdmin, getStudentFeesController);
feesRouter.route("/fees/:feeId").put(isLoggedIn, isAdmin, updateFeeController);
// C2: this is a soft delete (record flagged + audited), never a hard removal.
feesRouter.route("/fees/:feeId").delete(isLoggedIn, isAdmin, deleteFeeController);

feesRouter
  .route("/fees/ocr/extract")
  .post(isLoggedIn, isAdmin, upload.single("image"), cleanupUploadedFiles, extractFeesFromImageController);

// ---- Fee heads ----
feesRouter.route("/fee-heads").get(isLoggedIn, isAdmin, getAllFeeHeadsController);
feesRouter.route("/fee-heads").post(isLoggedIn, isAdmin, createFeeHeadController);
feesRouter.route("/fee-heads/:feeHeadId").put(isLoggedIn, isAdmin, updateFeeHeadController);
feesRouter.route("/fee-heads/:feeHeadId").delete(isLoggedIn, isAdmin, deleteFeeHeadController);

// ---- Daily collection report ----
feesRouter.route("/fees/collection/report").get(isLoggedIn, isAdmin, getDailyCollectionController);

// ---- Defaulter list ----
feesRouter.route("/fees/defaulters").get(isLoggedIn, isAdmin, getDefaulterListController);

module.exports = feesRouter;
