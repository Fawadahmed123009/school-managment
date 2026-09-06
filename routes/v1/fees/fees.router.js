const express = require("express");
const multer = require("multer");
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

const upload = multer({ dest: "uploads/" });

// ---- Fee records ----
feesRouter.route("/fees").post(isLoggedIn, isAdmin, createFeeController);
feesRouter.route("/fees").get(isLoggedIn, isAdmin, getAllFeesController);
feesRouter.route("/fees/bulk").post(isLoggedIn, isAdmin, bulkCreateFeesController);
feesRouter.route("/fees/bulk-assign").post(isLoggedIn, isAdmin, bulkAssignFeesController);
feesRouter.route("/fees/generate-monthly").post(isLoggedIn, isAdmin, generateMonthlyFeesController);
feesRouter.route("/fees/ocr/resolve/:feeId").post(isLoggedIn, isAdmin, resolveOcrReviewController);
feesRouter.route("/fees/student/:studentId").get(isLoggedIn, isAdmin, getStudentFeesController);
feesRouter.route("/fees/:feeId").put(isLoggedIn, isAdmin, updateFeeController);
feesRouter.route("/fees/:feeId").delete(isLoggedIn, isAdmin, deleteFeeController);

feesRouter
  .route("/fees/ocr/extract")
  .post(isLoggedIn, isAdmin, upload.single("image"), extractFeesFromImageController);

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
