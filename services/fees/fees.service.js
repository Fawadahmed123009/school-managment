const responseStatus = require("../../handlers/responseStatus.handler");
const Fees = require("../../models/Fees/fees.model");
const FeeHead = require("../../models/Fees/feeHead.model");
const Student = require("../../models/Students/students.model");
const { paginate } = require("../../utils/paginate");

/** Return the current billing month string in "YYYY-MM" format. */
function currentBillingMonth() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

exports.createFeeService = async (data, adminId, res) => {
  const fee = await Fees.create({ ...data, billingMonth: data.billingMonth || currentBillingMonth(), recordedBy: adminId });
  return responseStatus(res, 201, "success", fee);
};

exports.bulkCreateFeesService = async (rows, adminId, res) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return responseStatus(res, 400, "failed", "No fee rows provided");
  }

  // Validate each row's amount before processing
  const invalidRows = [];
  rows.forEach((row, idx) => {
    const amt = row.amount;
    if (amt == null || amt <= 0) {
      invalidRows.push({ index: idx, amount: amt, reason: amt == null ? "amount is null/missing" : amt === 0 ? "amount is zero" : "amount is negative" });
    }
  });

  if (invalidRows.length > 0) {
    return responseStatus(res, 400, "failed", {
      message: `${invalidRows.length} row(s) have invalid amounts`,
      invalidRows,
    });
  }

  const created = [];
  const updated = [];
  const needsReview = [];
  const today = new Date();

  for (const row of rows) {
    const { student: studentId, amount } = row;

    // Look for existing pending fees for this student with the exact same amount
    const pendingFees = await Fees.find({
      student: studentId,
      status: "pending",
      amount: amount,
    }).sort("createdAt");

    if (pendingFees.length === 1) {
      // Exact match — update existing record to paid
      const fee = pendingFees[0];
      fee.status = "paid";
      fee.datePaid = today;
      fee.notes = (fee.notes ? fee.notes + "; " : "") +
        `Marked paid via OCR confirmation on ${today.toISOString().slice(0, 10)}`;
      fee.source = fee.source || "ocr";
      await fee.save();
      updated.push(fee);
    } else if (pendingFees.length === 0) {
      // No match — create new paid record
      const [newFee] = await Fees.create([{
        ...row,
        billingMonth: row.billingMonth || currentBillingMonth(),
        status: "paid",
        datePaid: today,
        source: "ocr",
        recordedBy: adminId,
      }]);
      created.push(newFee);
    } else {
      // Ambiguous — more than one pending fee with same amount, flag for review
      const populated = await Fees.populate(pendingFees, {
        path: "student",
        select: "name rollNumber",
      });
      needsReview.push({
        studentId,
        studentName: populated[0].student?.name || "Unknown",
        amount,
        candidates: populated.map((f) => ({
          _id: f._id,
          feeType: f.feeType,
          feeHead: f.feeHead,
          amount: f.amount,
          createdAt: f.createdAt,
          notes: f.notes,
        })),
      });
    }
  }

  return responseStatus(res, 201, "success", {
    created,
    updated,
    needsReview,
    summary: {
      created: created.length,
      updated: updated.length,
      needsReview: needsReview.length,
    },
  });
};

/**
 * Resolve an ambiguous OCR match by marking the chosen candidate as paid.
 */
exports.resolveOcrReviewService = async (feeId, adminId, res) => {
  const fee = await Fees.findById(feeId);
  if (!fee) {
    return responseStatus(res, 404, "failed", "Fee record not found");
  }
  if (fee.status !== "pending") {
    return responseStatus(res, 400, "failed", "This fee record is no longer pending");
  }

  const today = new Date();
  fee.status = "paid";
  fee.datePaid = today;
  fee.notes = (fee.notes ? fee.notes + "; " : "") +
    `Marked paid via OCR admin review on ${today.toISOString().slice(0, 10)}`;
  fee.source = fee.source || "ocr";
  await fee.save();

  return responseStatus(res, 200, "success", fee);
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

/**
 * Bulk-assign a fee head to a group of students.
 * @param {Object} params
 * @param {string} params.feeHead       – FeeHead ObjectId
 * @param {number} [params.amount]      – override amount (defaults to feeHead.defaultAmount)
 * @param {string} params.targetType    – "class" | "all"
 * @param {string|string[]} [params.classLevel] – ClassLevel ObjectId(s) (required when targetType=class)
 * @param {string} [params.academicTerm] – optional AcademicTerm ObjectId
 * @param {string} [params.academicYear] – optional AcademicYear ObjectId
 * @param {string} adminId              – the admin performing the action
 */
exports.bulkAssignFeesService = async (params, adminId, res) => {
  const { feeHead: feeHeadId, amount, targetType, classLevel, academicTerm, academicYear, perStudentAmounts } = params;

  if (!feeHeadId) {
    return responseStatus(res, 400, "failed", "Fee head is required");
  }

  const head = await FeeHead.findById(feeHeadId);
  if (!head) {
    return responseStatus(res, 404, "failed", "Fee head not found");
  }

  const resolvedAmount = amount != null && amount !== "" ? Number(amount) : head.defaultAmount;
  if (!resolvedAmount || resolvedAmount <= 0) {
    return responseStatus(res, 400, "failed", "Amount must be greater than zero (set a default on the fee head or provide an override)");
  }

  // Normalise classLevel to an array (accepts single string or array from form)
  let classIds = [];
  if (classLevel) {
    classIds = Array.isArray(classLevel) ? classLevel : [classLevel];
    classIds = classIds.filter(Boolean); // strip empty strings
  }

  // Build student filter — exclude inactive, graduated, and withdrawn students
  const studentFilter = {
    status: { $ne: "inactive" },
    isGraduated: { $ne: true },
    isWithdrawn: { $ne: true },
  };
  if (targetType === "class") {
    if (classIds.length === 0) {
      return responseStatus(res, 400, "failed", "At least one class is required when targeting a class");
    }
    studentFilter.classLevel = { $in: classIds };
  }
  // "all" → no class filter (targetType=all or missing)

  const students = await Student.find(studentFilter).select("_id feeAgreed").lean();
  if (students.length === 0) {
    return responseStatus(res, 404, "failed", "No students found for the selected group");
  }

  // Skip students who already have a fee record for this fee head (avoid dupes)
  const studentIds = students.map((s) => s._id);
  const existingFees = await Fees.find({
    student: { $in: studentIds },
    feeHead: feeHeadId,
  }).select("student").lean();
  const existingSet = new Set(existingFees.map((f) => f.student.toString()));

  // Build a map of student → effective amount.
  // Priority order:
  //   1. perStudentAmounts[studentId]  – explicit per-student manual override (any fee head)
  //   2. feeAgreed                     – ONLY for Tuition fee head (student's agreed monthly rate)
  //   3. resolvedAmount                – group-level override or feeHead.defaultAmount
  const isTuition = /^tuition$/i.test(head.name);
  const studentAmountMap = {};

  // Layer 1: per-student manual overrides (from the bulk-assign form)
  let perStudentMap = {};
  if (perStudentAmounts) {
    if (typeof perStudentAmounts === 'string') {
      try { perStudentMap = JSON.parse(perStudentAmounts); } catch (_) { /* ignore parse errors */ }
    } else if (typeof perStudentAmounts === 'object') {
      perStudentMap = perStudentAmounts;
    }
  }

  // Layer 2: Tuition-specific feeAgreed (only when no per-student override set)
  students.forEach((s) => {
    const sid = s._id.toString();
    if (perStudentMap[sid] !== undefined && perStudentMap[sid] !== null && perStudentMap[sid] !== '') {
      studentAmountMap[sid] = Number(perStudentMap[sid]);
    } else if (isTuition && s.feeAgreed !== null && s.feeAgreed !== undefined) {
      studentAmountMap[sid] = s.feeAgreed;
    }
  });

  const newRows = studentIds
    .filter((id) => !existingSet.has(id.toString()))
    .map((student) => {
      const studentAmount = studentAmountMap[student.toString()] !== undefined
        ? studentAmountMap[student.toString()]
        : resolvedAmount;
      return {
        student,
        feeHead: feeHeadId,
        feeType: head.name,
        amount: studentAmount,
        status: "pending",
        source: "manual",
        billingMonth: currentBillingMonth(),
        recordedBy: adminId,
        ...(academicTerm ? { academicTerm } : {}),
        ...(academicYear ? { academicYear } : {}),
      };
    });

  if (newRows.length === 0) {
    return responseStatus(res, 200, "success", {
      message: `All ${students.length} student(s) already have a "${head.name}" fee record. Nothing created.`,
      created: 0,
      skipped: students.length,
    });
  }

  const created = await Fees.insertMany(newRows, { ordered: false });
  return responseStatus(res, 201, "success", {
    message: `Created ${created.length} fee record(s) for "${head.name}" at Rs ${resolvedAmount} each.`,
    created: created.length,
    skipped: students.length - created.length,
    totalStudents: students.length,
  });
};

/**
 * Generate this month's Tuition fees for all active students.
 * - Excludes graduated and withdrawn students.
 * - Skips students who already have a Tuition fee for the current billingMonth.
 * - Idempotent: safe to run multiple times in the same month.
 */
exports.generateMonthlyFeesService = async (adminId, res) => {
  const billingMonth = currentBillingMonth();

  // Find the Tuition fee head
  const tuitionHead = await FeeHead.findOne({
    name: { $regex: /^tuition$/i },
    isActive: true,
  });
  if (!tuitionHead) {
    return responseStatus(res, 404, "failed", 'No active "Tuition" fee head found. Create one first.');
  }

  const amount = tuitionHead.defaultAmount;
  if (!amount || amount <= 0) {
    return responseStatus(res, 400, "failed", "Tuition fee head has no default amount set (or it is zero).");
  }

  // Active students: NOT graduated AND NOT withdrawn AND status != 'inactive'
  // Fetch feeAgreed so we can use per-student override when set
  const activeStudents = await Student.find({
    status: { $ne: "inactive" },
    isGraduated: { $ne: true },
    isWithdrawn: { $ne: true },
  }).select("_id feeAgreed").lean();

  // Count graduated/withdrawn/inactive for the summary
  const totalExcluded = await Student.countDocuments({
    $or: [
      { isGraduated: true },
      { isWithdrawn: true },
      { status: "inactive" },
    ],
  });

  const activeIds = activeStudents.map((s) => s._id);

  if (activeIds.length === 0) {
    return responseStatus(res, 200, "success", {
      message: "No active students found.",
      generated: 0,
      alreadyGenerated: 0,
      skippedExcluded: totalExcluded,
      billingMonth,
    });
  }

  // Build a map of student → effective amount (feeAgreed overrides default when explicitly set)
  const studentAmountMap = {};
  activeStudents.forEach((s) => {
    if (s.feeAgreed !== null && s.feeAgreed !== undefined) {
      studentAmountMap[s._id.toString()] = s.feeAgreed;
    }
  });

  // Find students who already have a Tuition fee for this billing month
  const existingFees = await Fees.find({
    student: { $in: activeIds },
    feeHead: tuitionHead._id,
    billingMonth,
  }).select("student").lean();
  const alreadyHaveSet = new Set(existingFees.map((f) => f.student.toString()));

  // Build new fee records for students who don't have one yet
  // Use per-student feeAgreed when explicitly set (including 0 for scholarship),
  // otherwise fall back to the fee head's defaultAmount.
  const newRows = activeIds
    .filter((id) => !alreadyHaveSet.has(id.toString()))
    .map((student) => {
      const studentAmount = studentAmountMap[student.toString()] !== undefined
        ? studentAmountMap[student.toString()]
        : amount;
      return {
        student,
        feeHead: tuitionHead._id,
        feeType: tuitionHead.name,
        amount: studentAmount,
        status: "pending",
        source: "manual",
        billingMonth,
        recordedBy: adminId,
      };
    });

  let generatedCount = 0;
  if (newRows.length > 0) {
    const created = await Fees.insertMany(newRows, { ordered: false });
    generatedCount = created.length;
  }

  const alreadyGenerated = alreadyHaveSet.size;

  return responseStatus(res, 201, "success", {
    message: `${generatedCount} fee(s) generated, ${alreadyGenerated} student(s) already had this month's fee, ${totalExcluded} student(s) skipped (graduated/withdrawn/inactive).`,
    generated: generatedCount,
    alreadyGenerated,
    skippedExcluded: totalExcluded,
    billingMonth,
  });
};

/**
 * Preview bulk-assign: returns a per-class breakdown of how many students
 * will receive the fee vs already have it. Does NOT create any records.
 * @param {Object} params
 * @param {string} params.feeHead       – FeeHead ObjectId
 * @param {string} params.targetType    – "class" | "all"
 * @param {string|string[]} [params.classLevel] – ClassLevel ObjectId(s)
 */
exports.bulkAssignPreviewService = async (params) => {
  const { feeHead: feeHeadId, targetType, classLevel } = params;

  if (!feeHeadId) {
    throw new Error("Fee head is required");
  }

  const head = await FeeHead.findById(feeHeadId).select("name defaultAmount").lean();
  if (!head) {
    throw new Error("Fee head not found");
  }

  // Base exclusion filter
  const baseFilter = {
    status: { $ne: "inactive" },
    isGraduated: { $ne: true },
    isWithdrawn: { $ne: true },
  };

  // Normalise class IDs
  let classIds = [];
  if (classLevel) {
    classIds = Array.isArray(classLevel) ? classLevel : [classLevel];
    classIds = classIds.filter(Boolean);
  }

  // When targeting "all", we return a single row with no per-class breakdown
  if (targetType === "all" || classIds.length === 0) {
    const allStudents = await Student.find(baseFilter).select("_id name rollNumber").sort("name").lean();
    const allIds = allStudents.map((s) => s._id);
    const existingFees = allIds.length > 0
      ? await Fees.find({ student: { $in: allIds }, feeHead: feeHeadId }).select("student").lean()
      : [];
    const existingSet = new Set(existingFees.map((f) => f.student.toString()));
    const total = allIds.length;
    const skipped = allIds.filter((id) => existingSet.has(id.toString())).length;
    const students = allStudents.map((s) => ({
      _id: s._id.toString(),
      name: s.name,
      rollNumber: s.rollNumber,
      hasExisting: existingSet.has(s._id.toString()),
    }));
    return {
      feeHeadName: head.name,
      defaultAmount: head.defaultAmount,
      breakdown: [],
      totals: { total, new: total - skipped, skipped },
      students,
    };
  }

  // Per-class breakdown
  // Fetch class labels for display
  const ClassLevel = require("../../models/Academic/class.model");
  const classes = await ClassLevel.find({ _id: { $in: classIds } })
    .select("name gradeLevel section").lean();
  const classMap = {};
  classes.forEach((c) => { classMap[c._id.toString()] = c; });

  // Fetch all eligible students in selected classes with their classLevel
  const students = await Student.find({
    ...baseFilter,
    classLevel: { $in: classIds },
  }).select("_id name rollNumber classLevel").lean();

  // Fetch existing fee records for these students + feeHead
  const studentIds = students.map((s) => s._id);
  const existingFees = studentIds.length > 0
    ? await Fees.find({ student: { $in: studentIds }, feeHead: feeHeadId }).select("student").lean()
    : [];
  const existingSet = new Set(existingFees.map((f) => f.student.toString()));

  // Group students by class
  const byClass = {};
  classIds.forEach((id) => {
    byClass[id.toString()] = { total: 0, skipped: 0, students: [] };
  });
  students.forEach((s) => {
    const cId = s.classLevel ? s.classLevel.toString() : "unknown";
    if (!byClass[cId]) byClass[cId] = { total: 0, skipped: 0, students: [] };
    byClass[cId].total++;
    const hasExisting = existingSet.has(s._id.toString());
    if (hasExisting) {
      byClass[cId].skipped++;
    }
    byClass[cId].students.push({
      _id: s._id.toString(),
      name: s.name,
      rollNumber: s.rollNumber,
      hasExisting,
    });
  });

  const breakdown = classIds.map((id) => {
    const cid = id.toString();
    const c = classMap[cid];
    const stats = byClass[cid] || { total: 0, skipped: 0, students: [] };
    return {
      classId: cid,
      className: c ? `${c.gradeLevel} — ${c.name} (${c.section || '—'})` : 'Unknown class',
      total: stats.total,
      new: stats.total - stats.skipped,
      skipped: stats.skipped,
      students: stats.students,
    };
  });

  const totals = breakdown.reduce(
    (acc, r) => ({ total: acc.total + r.total, new: acc.new + r.new, skipped: acc.skipped + r.skipped }),
    { total: 0, new: 0, skipped: 0 }
  );

  return {
    feeHeadName: head.name,
    defaultAmount: head.defaultAmount,
    breakdown,
    totals,
  };
};
