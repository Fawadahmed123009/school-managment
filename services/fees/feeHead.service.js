const responseStatus = require("../../handlers/responseStatus.handler");
const FeeHead = require("../../models/Fees/feeHead.model");
const Fees = require("../../models/Fees/fees.model");
const { paginate } = require("../../utils/paginate");

// ---- Fee Head CRUD ----

exports.createFeeHeadService = async (data, adminId, res) => {
  const { name, description, defaultAmount } = data;
  if (!name) return responseStatus(res, 400, "failed", "Name is required");

  const exists = await FeeHead.findOne({ name: { $regex: new RegExp(`^${name}$`, "i") } });
  if (exists) return responseStatus(res, 409, "failed", "Fee head already exists");

  const feeHead = await FeeHead.create({
    name,
    description: description || "",
    defaultAmount: Number(defaultAmount) || 0,
    createdBy: adminId,
  });
  return responseStatus(res, 201, "success", feeHead);
};

// Find an existing fee head by name (case-insensitive) or create it, returning
// the FeeHead document directly. Lets the manual fee-entry form promote a head
// typed inline into a real, reusable catalog entry — same dedupe rule as
// createFeeHeadService, but usable outside the responseStatus request cycle
// (it returns the doc instead of writing a response, and reuses rather than
// 409s on an existing name).
exports.findOrCreateFeeHeadByName = async (name, adminId) => {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  // Escape free-text before building the RegExp so metacharacters can't throw
  // or match unintended heads.
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = await FeeHead.findOne({ name: { $regex: new RegExp(`^${escaped}$`, "i") } });
  if (existing) return existing;
  return await FeeHead.create({ name: trimmed, createdBy: adminId });
};

exports.getAllFeeHeadsService = async (query) => {
  return await paginate(FeeHead, {}, {
    page: query.page,
    limit: query.limit,
    sort: "name",
  });
};

exports.updateFeeHeadService = async (feeHeadId, data, res) => {
  const feeHead = await FeeHead.findByIdAndUpdate(feeHeadId, data, { new: true });
  if (!feeHead) return responseStatus(res, 404, "failed", "Fee head not found");
  return responseStatus(res, 200, "success", feeHead);
};

exports.deleteFeeHeadService = async (feeHeadId, res) => {
  const feeHead = await FeeHead.findByIdAndDelete(feeHeadId);
  if (!feeHead) return responseStatus(res, 404, "failed", "Fee head not found");
  return responseStatus(res, 200, "success", "Fee head deleted");
};

// ---- Daily Collection Report ----

exports.getDailyCollectionData = async (query) => {
  const { date, from, to } = query;

  // Build date range filter
  let dateFilter = {};
  if (date) {
    const day = new Date(date);
    day.setUTCHours(0, 0, 0, 0);
    const nextDay = new Date(day);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    dateFilter = { datePaid: { $gte: day, $lt: nextDay } };
  } else if (from && to) {
    dateFilter = { datePaid: { $gte: new Date(from), $lte: new Date(to) } };
  } else {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    dateFilter = { datePaid: { $gte: today, $lt: tomorrow } };
  }

  const fees = await Fees.find({ status: "paid", ...dateFilter })
    .populate({
      path: "student",
      select: "name classLevel rollNumber",
      populate: { path: "classLevel", select: "name gradeLevel group section" },
    })
    .populate("feeHead", "name")
    .sort({ datePaid: 1 });

  const byClass = {};
  let grandTotal = 0;

  fees.forEach((f) => {
    const student = f.student;
    const cls = student?.classLevel;
    const className = cls ? `${cls.gradeLevel} — ${cls.name}` : "Unassigned";
    const section = cls?.section || "—";

    if (!byClass[className]) byClass[className] = {};
    if (!byClass[className][section]) {
      byClass[className][section] = { fees: [], total: 0 };
    }

    byClass[className][section].fees.push({
      _id: f._id,
      studentName: student?.name || "Unknown",
      rollNumber: student?.rollNumber,
      feeHeadName: f.feeHead?.name || f.feeType || "—",
      amount: f.amount,
      datePaid: f.datePaid,
    });
    byClass[className][section].total += f.amount;
    grandTotal += f.amount;
  });

  const byHead = {};
  fees.forEach((f) => {
    const headName = f.feeHead?.name || f.feeType || "—";
    if (!byHead[headName]) byHead[headName] = { count: 0, total: 0 };
    byHead[headName].count++;
    byHead[headName].total += f.amount;
  });

  const reportDate = date || from || to || new Date().toISOString().slice(0, 10);

  return {
    date: reportDate,
    from: from || null,
    to: to || null,
    totalRecords: fees.length,
    grandTotal,
    byClass,
    byHead,
  };
};

// ---- Defaulter List ----

/**
 * Builds a list of students with any "pending" or "partial" fee record,
 * grouped by class and section (same grouping shape as the daily collection
 * report above). Optional filters: classLevelId, academicTermId.
 */
exports.getDefaulterListData = async (query) => {
  const { classLevel, academicTerm } = query;

  const feeFilter = { status: { $in: ["pending", "partial"] } };
  if (academicTerm) feeFilter.academicTerm = academicTerm;

  const fees = await Fees.find(feeFilter)
    .populate({
      path: "student",
      select: "name classLevel rollNumber whatsappNumber fatherName",
      populate: { path: "classLevel", select: "name gradeLevel group section" },
    })
    .populate("feeHead", "name");

  const byClass = {};
  let grandOwed = 0;
  let studentCount = 0;
  const seenStudents = new Set();

  fees.forEach((f) => {
    const student = f.student;
    if (!student) return; // orphaned fee record (student deleted)

    const cls = student.classLevel;
    if (classLevel && (!cls || cls._id.toString() !== classLevel)) return;

    const className = cls ? `${cls.gradeLevel} — ${cls.name}` : "Unassigned";
    const section = cls?.section || "—";

    if (!byClass[className]) byClass[className] = {};
    if (!byClass[className][section]) {
      byClass[className][section] = { students: {}, total: 0 };
    }

    const bucket = byClass[className][section];
    const sid = student._id.toString();
    if (!bucket.students[sid]) {
      bucket.students[sid] = {
        _id: student._id,
        name: student.name,
        rollNumber: student.rollNumber,
        fatherName: student.fatherName,
        whatsappNumber: student.whatsappNumber,
        owed: 0,
        items: [],
      };
      if (!seenStudents.has(sid)) {
        seenStudents.add(sid);
        studentCount++;
      }
    }

    bucket.students[sid].owed += f.amount;
    bucket.students[sid].items.push({
      feeHeadName: f.feeHead?.name || f.feeType || "—",
      amount: f.amount,
      status: f.status,
    });
    bucket.total += f.amount;
    grandOwed += f.amount;
  });

  // Flatten the students map into an array per section for easy EJS iteration
  Object.values(byClass).forEach((sections) => {
    Object.values(sections).forEach((bucket) => {
      bucket.students = Object.values(bucket.students);
    });
  });

  return { byClass, grandOwed, studentCount };
};
