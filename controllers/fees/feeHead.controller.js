const responseStatus = require("../../handlers/responseStatus.handler");
const {
  createFeeHeadService,
  getAllFeeHeadsService,
  updateFeeHeadService,
  deleteFeeHeadService,
  getDailyCollectionData,
  getDefaulterListData,
} = require("../../services/fees/feeHead.service");

exports.createFeeHeadController = async (req, res) => {
  try {
    await createFeeHeadService(req.body, req.userAuth.id, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAllFeeHeadsController = async (req, res) => {
  try {
    const result = await getAllFeeHeadsService(req.query);
    responseStatus(res, 200, "success", result);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.updateFeeHeadController = async (req, res) => {
  try {
    await updateFeeHeadService(req.params.feeHeadId, req.body, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.deleteFeeHeadController = async (req, res) => {
  try {
    await deleteFeeHeadService(req.params.feeHeadId, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getDailyCollectionController = async (req, res) => {
  try {
    const data = await getDailyCollectionData(req.query);
    responseStatus(res, 200, "success", data);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getDefaulterListController = async (req, res) => {
  try {
    const data = await getDefaulterListData(req.query);
    responseStatus(res, 200, "success", data);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};
