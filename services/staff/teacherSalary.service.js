const responseStatus = require("../../handlers/responseStatus.handler");
const mongoose = require("mongoose");
const Teacher = require("../../models/Staff/teachers.model");
const TeacherAttendance = require("../../models/Staff/teacherAttendance.model");
const TeacherAttendanceSettings = require("../../models/Staff/teacherAttendanceSettings.model");
const TeacherPayConfig = require("../../models/Staff/teacherPayConfig.model");
const TeacherSalaryRun = require("../../models/Staff/teacherSalaryRun.model");
const TeacherSalarySettings = require("../../models/Staff/teacherSalarySettings.model");
const { paginate } = require("../../utils/paginate");
const { parseDayStart, computeSalary } = require("../../utils/teacherSalaryCalc");
const { localDateKey } = require("../../utils/localDateKey");
const { recordAudit, changedFields, formatDay, formatMoney } = require("../audit/auditLog.service");

// ── shared helpers ──────────────────────────────────────────────────────────

// Same roster rule as Phase 1: withdrawn staff are excluded (they can no
// longer log in either). Suspended teachers still work, so they stay.
const ACTIVE_TEACHER_FILTER = { isWithdrawn: { $ne: true } };

// Defaults mirror the settings schema — used when no settings doc exists yet
// (deductions stay OFF until an admin enables them).
const SALARY_SETTINGS_DEFAULTS = {
  lateDeductionEnabled: false,
  deductionType: "flat",
  flatAmount: 0,
  percentValue: 0,
};

async function getSalarySettingsDoc() {
  const doc = await TeacherSalarySettings.findOne({ key: "default" }).lean();
  return { ...SALARY_SETTINGS_DEFAULTS, ...(doc || {}) };
}

// Phase 1 late rule — read-only here. Detection must be ON for any deduction
// to apply (the stored isLate flags are all false while it is off anyway).
async function getPhase1SettingsDoc() {
  const doc = await TeacherAttendanceSettings.findOne({ key: "default" }).lean();
  return { lateDetectionEnabled: false, ...(doc || {}) };
}

const nextDay = (d) => {
  const n = new Date(d);
  n.setDate(n.getDate() + 1);
  return n;
};

// Validate a teacher id + load the (non-withdrawn) teacher, or an error
// string. Fail-closed: a foreign/withdrawn id never calculates anything.
async function resolveActiveTeacher(teacherId) {
  if (!mongoose.Types.ObjectId.isValid(String(teacherId))) {
    return { error: "Invalid teacher id" };
  }
  const teacher = await Teacher.findOne({ _id: teacherId, ...ACTIVE_TEACHER_FILTER })
    .select("name teacherId")
    .lean();
  if (!teacher) return { error: "Teacher not found or withdrawn" };
  return { teacher };
}

// Finalized runs overlapping a period — surfaced as a WARNING (the admin may
// legitimately regenerate a correction), never a silent double-pay.
async function findFinalizedOverlaps(teacherId, start, end) {
  return TeacherSalaryRun.find({
    teacher: teacherId,
    status: "finalized",
    periodStart: { $lte: end },
    periodEnd: { $gte: start },
  })
    .select("periodStart periodEnd netAmount finalizedAt")
    .sort({ periodStart: 1 })
    .lean();
}

/**
 * Shared calculation core for preview AND generate — the generate path
 * recomputes everything server-side, so client-supplied amounts can never
 * reach a stored run. Returns { error, status } or { teacher, payload, overlaps }.
 */
async function computeRunPayload({ teacherId, startDate, endDate, lectureCount }) {
  const start = parseDayStart(startDate);
  const end = parseDayStart(endDate);
  if (!start || !end) {
    return { error: "Invalid date range — expected YYYY-MM-DD startDate and endDate", status: 400 };
  }
  if (start > end) {
    return { error: "startDate must not be after endDate", status: 400 };
  }

  // Optional lecture override (per-lecture teachers): whole number >= 0.
  let lectureOverride;
  if (lectureCount !== undefined && lectureCount !== null && String(lectureCount) !== "") {
    const n = Number(lectureCount);
    if (!Number.isInteger(n) || n < 0) {
      return { error: "Lecture count must be a whole number of 0 or more", status: 400 };
    }
    lectureOverride = n;
  }

  const resolved = await resolveActiveTeacher(teacherId);
  if (resolved.error) return { error: resolved.error, status: 400 };
  const { teacher } = resolved;

  const configs = await TeacherPayConfig.find({ teacher: teacher._id }).lean();
  if (configs.length === 0) {
    return { error: "Pay rate not set for this teacher — configure a pay rate first", status: 400 };
  }

  // Exact custom range: both ends inclusive (local-midnight buckets, same
  // convention as the Phase 1 history query).
  const records = await TeacherAttendance.find({
    teacher: teacher._id,
    date: { $gte: start, $lt: nextDay(end) },
  }).lean();

  const [salarySettings, phase1Settings] = await Promise.all([
    getSalarySettingsDoc(),
    getPhase1SettingsDoc(),
  ]);

  const payload = computeSalary({
    records,
    configs,
    start,
    end,
    salarySettings,
    phase1Settings,
    lectureOverride,
  });
  if (payload.error) return { error: payload.error, status: 400 };

  const overlaps = await findFinalizedOverlaps(teacher._id, start, end);
  return { teacher, payload, overlaps, start, end };
}

// ── pay-rate configuration (admin only) ─────────────────────────────────────

/**
 * Every active teacher with their current rate, full rate history and a
 * hasConfig flag — the generation UI uses the flag for the "Pay rate not
 * set" pill (mirrors the Phase 1 "expected arrival not set" pill).
 */
exports.getTeacherPayConfigsService = async (res) => {
  const teachers = await Teacher.find(ACTIVE_TEACHER_FILTER)
    .select("name teacherId")
    .sort({ name: 1 })
    .lean();

  const ids = teachers.map((t) => t._id);
  const configs = ids.length
    ? await TeacherPayConfig.find({ teacher: { $in: ids } }).sort({ effectiveFrom: -1 }).lean()
    : [];

  const byTeacher = {};
  configs.forEach((c) => {
    const key = String(c.teacher);
    (byTeacher[key] = byTeacher[key] || []).push(c);
  });

  // Local "today" (NOT toISOString — that shifts to UTC and can land on the
  // wrong day; attendance buckets are server-local midnight).
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rows = teachers.map((t) => {
    const history = byTeacher[String(t._id)] || [];
    const current = history[0] || null;
    return {
      teacher: t._id,
      name: t.name,
      teacherId: t.teacherId || "",
      hasConfig: history.length > 0,
      // A config exists but only takes effect in the future → runs for
      // today's period still fail closed; the UI shows "scheduled".
      effectiveNow: !!current && new Date(current.effectiveFrom) <= today,
      current: current
        ? { payType: current.payType, rateAmount: current.rateAmount, effectiveFrom: current.effectiveFrom }
        : null,
      history: history.map((c) => ({
        _id: c._id,
        payType: c.payType,
        rateAmount: c.rateAmount,
        effectiveFrom: c.effectiveFrom,
        createdAt: c.createdAt,
      })),
    };
  });

  return responseStatus(res, 200, "success", rows);
};

/**
 * INSERT a new rate row — never update an existing one, so historical salary
 * runs keep resolving the rate that was effective during their period.
 */
exports.createTeacherPayConfigService = async (payload, adminId, res) => {
  const resolved = await resolveActiveTeacher(payload.teacher);
  if (resolved.error) return responseStatus(res, 400, "failed", resolved.error);

  const payType = payload.payType;
  if (payType !== "per-hour" && payType !== "per-lecture") {
    return responseStatus(res, 400, "failed", "Pay type must be per-hour or per-lecture");
  }

  const rateAmount = Number(payload.rateAmount);
  if (!Number.isFinite(rateAmount) || rateAmount <= 0) {
    return responseStatus(res, 400, "failed", "Rate must be a positive amount");
  }

  const effectiveFrom = parseDayStart(payload.effectiveFrom);
  if (!effectiveFrom) {
    return responseStatus(res, 400, "failed", "Invalid effective-from date — expected YYYY-MM-DD");
  }

  // One row per effective date — a second row on the same day would make
  // rate resolution ambiguous.
  const clash = await TeacherPayConfig.findOne({ teacher: resolved.teacher._id, effectiveFrom }).lean();
  if (clash) {
    return responseStatus(res, 400, "failed", "A rate already exists for this effective date — pick a different date");
  }

  const created = await TeacherPayConfig.create({
    teacher: resolved.teacher._id,
    payType,
    rateAmount: Math.round(rateAmount * 100) / 100,
    effectiveFrom,
    createdBy: adminId,
  });

  // Audit trail (fail-open). Rate history is INSERT-only — a rate "update"
  // is a new effective-dated row, so this create hook covers both cases.
  recordAudit({
    userId: adminId,
    actionType: "create",
    entityType: "pay_config",
    entityId: created._id,
    summary: `Set pay rate for ${resolved.teacher.name}: ${formatMoney(created.rateAmount)}/${payType === "per-hour" ? "hour" : "lecture"} effective ${formatDay(effectiveFrom)}`,
    afterSnapshot: {
      teacher: resolved.teacher.name,
      payType,
      rateAmount: created.rateAmount,
      effectiveFrom: localDateKey(effectiveFrom),
    },
  });

  return responseStatus(res, 201, "success", created);
};

// ── deduction rule (admin only) ─────────────────────────────────────────────

exports.getTeacherSalarySettingsService = async (res) => {
  const settings = await getSalarySettingsDoc();
  return responseStatus(res, 200, "success", {
    lateDeductionEnabled: settings.lateDeductionEnabled,
    deductionType: settings.deductionType,
    flatAmount: settings.flatAmount,
    percentValue: settings.percentValue,
    updatedBy: settings.updatedBy || null,
    updatedAt: settings.updatedAt || null,
  });
};

exports.updateTeacherSalarySettingsService = async (payload, adminId, res) => {
  const enabled = payload.lateDeductionEnabled === true;
  const deductionType = payload.deductionType;
  if (deductionType !== "flat" && deductionType !== "percent") {
    return responseStatus(res, 400, "failed", "Deduction type must be flat or percent");
  }

  const flatAmount = Number(payload.flatAmount);
  const percentValue = Number(payload.percentValue);
  if (!Number.isFinite(flatAmount) || flatAmount < 0) {
    return responseStatus(res, 400, "failed", "Flat deduction must be 0 or more");
  }
  if (!Number.isFinite(percentValue) || percentValue < 0 || percentValue > 100) {
    return responseStatus(res, 400, "failed", "Percent deduction must be between 0 and 100");
  }

  const settings = await TeacherSalarySettings.findOneAndUpdate(
    { key: "default" },
    {
      $set: {
        lateDeductionEnabled: enabled,
        deductionType,
        flatAmount: Math.round(flatAmount * 100) / 100,
        percentValue: Math.round(percentValue * 100) / 100,
        updatedBy: adminId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  return responseStatus(res, 200, "success", {
    lateDeductionEnabled: settings.lateDeductionEnabled,
    deductionType: settings.deductionType,
    flatAmount: settings.flatAmount,
    percentValue: settings.percentValue,
  });
};

// ── preview (dry run — zero writes) ─────────────────────────────────────────

exports.previewTeacherSalaryService = async (payload, res) => {
  const computed = await computeRunPayload(payload || {});
  if (computed.error) return responseStatus(res, computed.status, "failed", computed.error);

  const { teacher, payload: calc, overlaps, start, end } = computed;
  const existingDraft = await TeacherSalaryRun.findOne({
    teacher: teacher._id,
    periodStart: start,
    periodEnd: end,
    status: "draft",
  })
    .select("_id")
    .lean();

  return responseStatus(res, 200, "success", {
    teacher: { _id: teacher._id, name: teacher.name, teacherId: teacher.teacherId || "" },
    periodStart: start,
    periodEnd: end,
    ...calc,
    overlaps,
    replacesDraftId: existingDraft ? existingDraft._id : null,
  });
};

// ── generate / list / detail / finalize / delete ────────────────────────────

/**
 * Generate a DRAFT run. Everything is recomputed server-side (the preview is
 * a dry run, never a trusted input). Regenerating the same teacher+period
 * replaces the existing draft atomically; finalized runs are never touched.
 */
exports.generateTeacherSalaryService = async (payload, adminId, res) => {
  const computed = await computeRunPayload(payload || {});
  if (computed.error) return responseStatus(res, computed.status, "failed", computed.error);

  const { teacher, payload: calc, overlaps, start, end } = computed;

  // Audit pre-read: capture the draft being replaced (if any) so the trail
  // can show what changed. Read-only — the upsert below is unchanged.
  const prevDraft = await TeacherSalaryRun.findOne({
    teacher: teacher._id,
    periodStart: start,
    periodEnd: end,
    status: "draft",
  })
    .select("status grossAmount lateDeductionAmount netAmount totalWorkingDays totalWorkingHours lateDays lectureCount")
    .lean();

  const run = await TeacherSalaryRun.findOneAndUpdate(
    { teacher: teacher._id, periodStart: start, periodEnd: end, status: "draft" },
    {
      $set: {
        ...calc,
        periodStart: start,
        periodEnd: end,
        generatedBy: adminId,
        generatedAt: new Date(),
      },
      $setOnInsert: { status: "draft" },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  // Audit trail (fail-open, fire-and-forget — never blocks generation).
  const runKeys = ["status", "grossAmount", "lateDeductionAmount", "netAmount", "totalWorkingDays", "totalWorkingHours", "lateDays", "lectureCount"];
  const diff = prevDraft ? changedFields(prevDraft, run, runKeys) : null;
  const afterBase = {
    periodStart: localDateKey(start),
    periodEnd: localDateKey(end),
    status: run.status,
    grossAmount: run.grossAmount,
    lateDeductionAmount: run.lateDeductionAmount,
    netAmount: run.netAmount,
    totalWorkingDays: run.totalWorkingDays,
    totalWorkingHours: run.totalWorkingHours,
    lateDays: run.lateDays,
    lectureCount: run.lectureCount,
  };
  recordAudit({
    userId: adminId,
    actionType: "generate",
    entityType: "salary_run",
    entityId: run._id,
    summary: `${prevDraft ? "Regenerated" : "Generated"} salary run for ${teacher.name}, ${formatDay(start)} – ${formatDay(end)} (net ${formatMoney(run.netAmount)})`,
    beforeSnapshot: diff ? diff.before : null,
    afterSnapshot: diff ? diff.after : afterBase,
  });

  return responseStatus(res, 201, "success", { run, overlaps });
};

exports.getTeacherSalaryRunsService = async (filters, res) => {
  const match = {};
  if (filters.teacherId) {
    if (!mongoose.Types.ObjectId.isValid(String(filters.teacherId))) {
      return responseStatus(res, 400, "failed", "Invalid teacher id");
    }
    match.teacher = new mongoose.Types.ObjectId(String(filters.teacherId));
  }
  if (filters.status) {
    if (filters.status !== "draft" && filters.status !== "finalized") {
      return responseStatus(res, 400, "failed", "Status must be draft or finalized");
    }
    match.status = filters.status;
  }

  const { data, pagination } = await paginate(TeacherSalaryRun, match, {
    page: filters.page,
    limit: filters.limit,
    sort: "-periodStart -createdAt",
    populate: { path: "teacher", select: "name teacherId" },
  });

  return responseStatus(res, 200, "success", { runs: data, pagination });
};

exports.getTeacherSalaryRunService = async (id, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    return responseStatus(res, 400, "failed", "Invalid run id");
  }
  const run = await TeacherSalaryRun.findById(id)
    .populate({ path: "teacher", select: "name teacherId" })
    .lean();
  if (!run) return responseStatus(res, 404, "failed", "Salary run not found");
  return responseStatus(res, 200, "success", run);
};

/** Lock a draft. Finalized runs are immutable — a second finalize is a 400. */
exports.finalizeTeacherSalaryRunService = async (id, adminId, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    return responseStatus(res, 400, "failed", "Invalid run id");
  }
  const run = await TeacherSalaryRun.findOneAndUpdate(
    { _id: id, status: "draft" },
    { $set: { status: "finalized", finalizedBy: adminId, finalizedAt: new Date() } },
    { new: true }
  ).lean();
  if (!run) {
    const existing = await TeacherSalaryRun.findById(id).select("status").lean();
    if (!existing) return responseStatus(res, 404, "failed", "Salary run not found");
    return responseStatus(res, 400, "failed", "Only draft runs can be finalized");
  }
  // Audit trail (fail-open). {teacher} is resolved by the audit writer off
  // the main path, so finalization needs no extra name lookup here.
  recordAudit({
    userId: adminId,
    actionType: "finalize",
    entityType: "salary_run",
    entityId: run._id,
    teacherId: run.teacher,
    summary: `Finalized salary run for {teacher}, ${formatDay(run.periodStart)} – ${formatDay(run.periodEnd)} (net ${formatMoney(run.netAmount)})`,
    beforeSnapshot: { status: "draft" },
    afterSnapshot: { status: "finalized", finalizedAt: run.finalizedAt },
  });
  return responseStatus(res, 200, "success", run);
};

/** Delete a DRAFT only — finalized runs are a permanent pay record. */
exports.deleteTeacherSalaryRunService = async (id, res) => {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    return responseStatus(res, 400, "failed", "Invalid run id");
  }
  const run = await TeacherSalaryRun.findOneAndDelete({ _id: id, status: "draft" }).lean();
  if (!run) {
    const existing = await TeacherSalaryRun.findById(id).select("status").lean();
    if (!existing) return responseStatus(res, 404, "failed", "Salary run not found");
    return responseStatus(res, 400, "failed", "Finalized runs cannot be deleted");
  }
  return responseStatus(res, 200, "success", { deleted: run._id });
};