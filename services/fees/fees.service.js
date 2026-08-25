const responseStatus = require("../../handlers/responseStatus.handler");
const Fees = require("../../models/Fees/fees.model");
const { paginate } = require("../../utils/paginate");

exports.createFeeService = async (data, adminId, res) => {
  const fee = await Fees.create({ ...data, recordedBy: adminId });
  return responseStatus(res, 201, "success", fee);
};

exports.bulkCreateFeesService = async (rows, adminId, res) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return responseStatus(res, 400, "failed", "No fee rows provided");
  }
  const prepared = rows.map((row) => ({ ...row, recordedBy: adminId, source: "ocr" }));
  const created = await Fees.insertMany(prepared, { ordered: false });
  return responseStatus(res, 201, "success", created);
};

exports.getAllFeesService = async (filters, query, res) => {
  const result = await paginate(Fees, filters, {
    page: query.page,
    limit: query.limit,
    sort: "-createdAt",
    populate: [
      { path: "student", select: "name rollNumber" },
      { path: "academicTerm" },
      { path: "academicYear" },
      { path: "feeHead", select: "name" },
    ],
  });
  return responseStatus(res, 200, "success", result);
};

exports.getStudentFeesService = async (studentId, res) => {
  const fees = await Fees.find({ student: studentId });
  return responseStatus(res, 200, "success", fees);
};

exports.updateFeeService = async (feeId, data, res) => {
  const fee = await Fees.findByIdAndUpdate(feeId, data, { new: true });
  if (!fee) return responseStatus(res, 404, "failed", "Fee record not found");
  return responseStatus(res, 200, "success", fee);
};

exports.deleteFeeService = async (feeId, res) => {
  const fee = await Fees.findByIdAndDelete(feeId);
  if (!fee) return responseStatus(res, 404, "failed", "Fee record not found");
  return responseStatus(res, 200, "success", "Fee record deleted");
};
