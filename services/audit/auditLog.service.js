const mongoose = require("mongoose");
const responseStatus = require("../../handlers/responseStatus.handler");
const AuditLog = require("../../models/Audit/auditLog.model");
const logger = require("../../config/logger");
const { getRequestContext } = require("../../middlewares/requestContext");
const { paginate } = require("../../utils/paginate");
const { dayRangeFilter, parseDayStart } = require("../../utils/dateRange");

// ── Audit trail foundation (additive, fail-OPEN) ────────────────────────────
// Unlike the fees/test deletion audits (fail-closed: no audit → no mutation),
// this general trail must NEVER block or fail the original action. Hooks call
// recordAudit(), which dispatches the write fire-and-forget: any failure is
// reported to the server error log and swallowed. The main action's response
// is already on its way and is never touched.

const ACTION_TYPES = ["create", "update", "deactivate", "activate", "generate", "finalize"];
const ENTITY_TYPES = [
  "expense_head",
  "expense_entry",
  "income_head",
  "income_entry",
  "pay_config",
  "salary_run",
  "teacher_attendance",
  "teacher_expected_times",
];

// In-flight writes, so tests / dry-run scripts can deterministically await
// completion (flushAuditWrites). Production code never waits on this.
const pending = new Set();

// ── shared display helpers (used by hooks to build human-readable summaries) ──

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Local-calendar day ("15 Nov 2026") — never toISOString (UTC shift), matching
// the server-local midnight convention of every date this app stores.
function formatDay(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Money display follows the fees/salary views ("Rs", 2 decimals).
function formatMoney(n) {
  return "Rs " + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Build lightweight before/after snapshots holding ONLY the fields that
 * actually changed. Returns { before, after } (null when nothing changed).
 */
function changedFields(before, after, keys) {
  const b = {};
  const a = {};
  let any = false;
  for (const key of keys) {
    const from = before ? before[key] : undefined;
    const to = after ? after[key] : undefined;
    const fromVal = from === undefined ? "" : from;
    const toVal = to === undefined ? "" : to;
    if (String(fromVal) !== String(toVal)) {
      b[key] = fromVal;
      a[key] = toVal;
      any = true;
    }
  }
  return any ? { before: b, after: a } : null;
}

// ── actor resolution (DB-derived, never a token/cookie claim) ───────────────

async function resolveActor(userId) {
  const Admin = require("../../models/Staff/admin.model");
  const Teacher = require("../../models/Staff/teachers.model");
  const admin = await Admin.findById(userId).select("name role").lean();
  if (admin) return { role: admin.role || "admin", name: admin.name || "Unknown" };
  const teacher = await Teacher.findById(userId).select("name isAttendanceManager").lean();
  if (teacher) {
    return { role: teacher.isAttendanceManager ? "manager" : "teacher", name: teacher.name || "Unknown" };
  }
  return { role: "unknown", name: "Unknown" };
}

// The actual write — runs entirely OFF the main action's path.
async function writeAudit(entry) {
  const actor = await resolveActor(entry.userId);

  // Summaries may carry a {teacher} placeholder so hooks never need an extra
  // name lookup on the main path; it is resolved here, asynchronously.
  let summary = String(entry.summary || "");
  if (entry.teacherId && summary.includes("{teacher}")) {
    const Teacher = require("../../models/Staff/teachers.model");
    const teacher = await Teacher.findById(entry.teacherId).select("name").lean();
    summary = summary.split("{teacher}").join(teacher ? teacher.name : "Unknown teacher");
  }

  const ctx = getRequestContext();
  await AuditLog.create({
    userId: entry.userId,
    userRole: actor.role,
    actionType: entry.actionType,
    entityType: entry.entityType,
    entityId: entry.entityId || null,
    summary,
    beforeSnapshot: entry.beforeSnapshot || null,
    afterSnapshot: entry.afterSnapshot || null,
    ipAddress: (ctx && ctx.ip) || "",
    timestamp: new Date(),
  });
}

/**
 * Record one audit event. FAIL-OPEN and non-blocking by contract:
 * never throws, never awaits the write on the caller's path. A failed write
 * is logged to the server error log (logs/error.log) and nothing else.
 *
 * entry: { userId, actionType, entityType, entityId?, summary,
 *          beforeSnapshot?, afterSnapshot?, teacherId? }
 */
function recordAudit(entry) {
  try {
    if (!entry || !entry.userId) return;
    if (!ACTION_TYPES.includes(entry.actionType) || !ENTITY_TYPES.includes(entry.entityType)) {
      logger.error(`audit-log rejected invalid entry: ${entry.actionType}/${entry.entityType}`);
      return;
    }
    const state = mongoose.connection.readyState;
    if (state !== 1) {
      // 0 = disconnected (unit tests run without a DB — skip quietly);
      // 2/3 = connecting/disconnecting: a real outage worth surfacing.
      if (state !== 0) logger.warn("audit-log skipped: database not connected");
      return;
    }
    const p = writeAudit(entry)
      .catch((err) => {
        logger.error(
          `audit-log write failed (${entry.entityType}/${entry.actionType}, entity ${entry.entityId || "—"}): ${err.message}`
        );
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  } catch (err) {
    // Even a synchronous dispatch failure must never reach the caller.
    logger.error(`audit-log dispatch failed: ${err.message}`);
  }
}

/** Await all in-flight audit writes — for tests and dry-run verification only. */
async function flushAuditWrites() {
  await Promise.all([...pending]);
}

// ── viewer queries (admin-only surface) ─────────────────────────────────────

// Resolve display names for a set of user ids (admins + teachers/managers).
async function resolveUserNames(ids) {
  if (!ids.length) return {};
  const Admin = require("../../models/Staff/admin.model");
  const Teacher = require("../../models/Staff/teachers.model");
  const [admins, teachers] = await Promise.all([
    Admin.find({ _id: { $in: ids } }).select("name role").lean(),
    Teacher.find({ _id: { $in: ids } }).select("name isAttendanceManager").lean(),
  ]);
  const map = {};
  admins.forEach((a) => { map[String(a._id)] = { name: a.name || "Unknown", role: a.role || "admin" }; });
  teachers.forEach((t) => {
    map[String(t._id)] = { name: t.name || "Unknown", role: t.isAttendanceManager ? "manager" : "teacher" };
  });
  return map;
}

/**
 * Chronological audit list (newest first) with inclusive local-day date range,
 * entity-type and user filters. Same validation rules as the expense history.
 */
exports.getAuditLogsService = async (filters = {}, res) => {
  const match = {};

  const from = filters.from ? parseDayStart(filters.from) : null;
  const to = filters.to ? parseDayStart(filters.to) : null;
  if (filters.from && !from) return responseStatus(res, 400, "failed", "Invalid from date — expected YYYY-MM-DD");
  if (filters.to && !to) return responseStatus(res, 400, "failed", "Invalid to date — expected YYYY-MM-DD");
  if (from && to && from > to) return responseStatus(res, 400, "failed", "From date must not be after to date");
  if (from || to) match.timestamp = dayRangeFilter(filters.from, filters.to);

  if (filters.entityType) {
    if (!ENTITY_TYPES.includes(filters.entityType)) {
      return responseStatus(res, 400, "failed", "Unknown entity type");
    }
    match.entityType = filters.entityType;
  }

  if (filters.userId) {
    if (!mongoose.Types.ObjectId.isValid(String(filters.userId))) {
      return responseStatus(res, 400, "failed", "Invalid user id");
    }
    // Cast explicitly: aggregation/$match-style filters don't auto-cast here.
    match.userId = new mongoose.Types.ObjectId(String(filters.userId));
  }

  const { data, pagination } = await paginate(AuditLog, match, {
    page: filters.page,
    limit: filters.limit,
    sort: "-timestamp",
  });

  const ids = [...new Set(data.map((r) => String(r.userId)))];
  const nameById = await resolveUserNames(ids);
  const logs = data.map((r) => ({
    ...r,
    userName: (nameById[String(r.userId)] || {}).name || "Unknown",
  }));

  return responseStatus(res, 200, "success", { logs, pagination });
};

/** Filter options for the viewer: every user who appears in the trail. */
exports.getAuditLogMetaService = async (res) => {
  const ids = await AuditLog.distinct("userId");
  const nameById = await resolveUserNames(ids);
  const users = ids
    .map((id) => ({
      _id: id,
      name: (nameById[String(id)] || {}).name || "Unknown",
      role: (nameById[String(id)] || {}).role || "unknown",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return responseStatus(res, 200, "success", { entityTypes: ENTITY_TYPES, users });
};

exports.ACTION_TYPES = ACTION_TYPES;
exports.ENTITY_TYPES = ENTITY_TYPES;
exports.recordAudit = recordAudit;
exports.flushAuditWrites = flushAuditWrites;
exports.changedFields = changedFields;
exports.formatDay = formatDay;
exports.formatMoney = formatMoney;