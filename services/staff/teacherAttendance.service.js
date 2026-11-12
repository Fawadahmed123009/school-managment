const responseStatus = require("../../handlers/responseStatus.handler");
const mongoose = require("mongoose");
const Teacher = require("../../models/Staff/teachers.model");
const TeacherAttendance = require("../../models/Staff/teacherAttendance.model");
const TeacherAttendanceSettings = require("../../models/Staff/teacherAttendanceSettings.model");
const { paginate } = require("../../utils/paginate");
const {
  isValidTime,
  computeWorkingMinutes,
  computeLateFlag,
  timeToMinutes,
  hhmmFromDate,
  dayStartFromDate,
} = require("../../utils/teacherAttendanceTime");

// ── shared helpers ──────────────────────────────────────────────────────────

// Defaults mirror the settings schema — used when no settings doc exists yet
// (late detection stays OFF until an admin enables it; the standing grace
// period is 5 minutes past the expected entry time).
const SETTINGS_DEFAULTS = {
  lateDetectionEnabled: false,
  startTime: "08:00",
  graceMinutes: 5,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "YYYY-MM-DD" → Date at server-LOCAL midnight (same convention as student
// attendance marking), or null when malformed / not a real calendar day.
function parseDayStart(dateStr) {
  if (typeof dateStr !== "string" || !DATE_RE.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  if (day.getFullYear() !== y || day.getMonth() !== m - 1 || day.getDate() !== d) return null;
  day.setHours(0, 0, 0, 0);
  return day;
}

// Teachers expected on the roster: withdrawn staff are excluded (they can no
// longer log in either). Suspended teachers still work, so they stay.
const ACTIVE_TEACHER_FILTER = { isWithdrawn: { $ne: true } };

async function getSettingsDoc() {
  const doc = await TeacherAttendanceSettings.findOne({ key: "default" }).lean();
  return { ...SETTINGS_DEFAULTS, ...(doc || {}) };
}

// ── marking (manager/admin) ─────────────────────────────────────────────────

/**
 * Upsert one day's arrival/departure records for a set of teachers.
 * Mirrors markClassAttendanceService: validate the WHOLE payload first
 * (fail-closed — nothing is written when any row is invalid), then upsert
 * each row on the unique {teacher, date} key.
 *
 * Since login-capture, a row may correct just ONE time (e.g. only the
 * departure of a teacher who forgot to log out): values that are not
 * provided are merged from the day's existing record, and the manager-
 * provided side becomes "manual" while a preserved side keeps its
 * original provenance. The final pair must always be valid (arrival
 * required; departure, when present, strictly after arrival).
 */
exports.markTeacherAttendanceService = async (date, records, markedBy, res) => {
  if (!Array.isArray(records) || records.length === 0) {
    return responseStatus(res, 400, "failed", "No attendance records provided");
  }

  const day = parseDayStart(date);
  if (!day) {
    return responseStatus(res, 400, "failed", "Invalid date — expected YYYY-MM-DD");
  }

  // Per-row validation before any write: ids unique+valid, any PROVIDED
  // time a complete HH:MM, and a provided PAIR consistent.
  const providedTime = (v) => v !== undefined && v !== null && String(v) !== "";
  const seen = new Set();
  for (const r of records) {
    const id = String(r && r.teacher);
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return responseStatus(res, 400, "failed", "Invalid teacher id in records");
    }
    if (seen.has(id)) {
      return responseStatus(res, 400, "failed", "Duplicate teacher in records");
    }
    seen.add(id);
    if ((providedTime(r.arrivalTime) && !isValidTime(r.arrivalTime)) ||
        (providedTime(r.departureTime) && !isValidTime(r.departureTime))) {
      return responseStatus(res, 400, "failed", "Arrival and departure must be HH:MM (24-hour) times");
    }
    if (providedTime(r.arrivalTime) && providedTime(r.departureTime) &&
        computeWorkingMinutes(r.arrivalTime, r.departureTime) === null) {
      return responseStatus(res, 400, "failed", "Departure time must be after arrival time");
    }
  }

  // Fail-closed guard: only existing, non-withdrawn teachers may be marked.
  // A direct API POST naming a withdrawn (or foreign) teacher is rejected in
  // full and nothing is written — hiding the row in the UI isn't enough.
  // The same query carries each teacher's expected arrival time: lateness is
  // judged against THAT (staff profile), never the global start time.
  const ids = records.map((r) => String(r.teacher));
  const allowed = await Teacher.find({ _id: { $in: ids }, ...ACTIVE_TEACHER_FILTER })
    .select("_id expectedArrivalTime")
    .lean();
  const allowedSet = new Set(allowed.map((t) => t._id.toString()));
  const disallowed = ids.filter((id) => !allowedSet.has(id));
  if (disallowed.length > 0) {
    return responseStatus(res, 403, "failed", "Cannot mark attendance for withdrawn or unknown teachers");
  }
  const expectedById = {};
  allowed.forEach((t) => { expectedById[t._id.toString()] = t.expectedArrivalTime || ""; });

  const settings = await getSettingsDoc();

  // Merge each row with the day's existing record (single-field corrections
  // keep the other captured value) and validate the FINAL pair — still
  // fail-closed: nothing is written when any merged row is invalid.
  const existingRows = await TeacherAttendance.find({ date: day, teacher: { $in: ids } }).lean();
  const prevById = {};
  existingRows.forEach((e) => { prevById[String(e.teacher)] = e; });

  const merged = [];
  for (const r of records) {
    const id = String(r.teacher);
    const prev = prevById[id] || {};
    const arrivalTime = providedTime(r.arrivalTime) ? r.arrivalTime : prev.arrivalTime || "";
    const departureTime = providedTime(r.departureTime) ? r.departureTime : prev.departureTime || "";
    if (!isValidTime(arrivalTime)) {
      return responseStatus(res, 400, "failed", "Arrival time is required (nothing recorded for this teacher yet)");
    }
    if (departureTime && computeWorkingMinutes(arrivalTime, departureTime) === null) {
      return responseStatus(res, 400, "failed", "Departure time must be after arrival time");
    }
    merged.push({
      id,
      arrivalTime,
      departureTime,
      arrivalSource: providedTime(r.arrivalTime) ? "manual" : prev.arrivalSource || "manual",
      departureSource: providedTime(r.departureTime) ? "manual" : prev.departureSource || "manual",
    });
  }

  const results = [];
  for (const m of merged) {
    // Arrival-only (no logout captured yet) → 0 minutes so far; the logout
    // or a later correction completes the pair.
    const workingMinutes = m.departureTime ? computeWorkingMinutes(m.arrivalTime, m.departureTime) : 0;
    // Per-teacher expectation; unset → the late check is skipped for them.
    const { isLate, lateMinutes } = computeLateFlag(m.arrivalTime, settings, expectedById[m.id]);
    const updated = await TeacherAttendance.findOneAndUpdate(
      { teacher: m.id, date: day },
      {
        $set: {
          teacher: m.id,
          date: day,
          arrivalTime: m.arrivalTime,
          departureTime: m.departureTime,
          workingMinutes,
          isLate,
          lateMinutes,
          updatedBy: markedBy,
          // A manager/admin save is an explicit correction — the side they
          // provided becomes "manual" (auto paths never overwrite it); a
          // preserved side keeps its original provenance.
          arrivalSource: m.arrivalSource,
          departureSource: m.departureSource,
        },
        $setOnInsert: { createdBy: markedBy },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    results.push(updated);
  }

  return responseStatus(res, 201, "success", results);
};

// ── day roster (pre-fills the marking UI) ───────────────────────────────────

exports.getTeacherAttendanceDayService = async (date, res) => {
  const day = parseDayStart(date);
  if (!day) {
    return responseStatus(res, 400, "failed", "Invalid date — expected YYYY-MM-DD");
  }

  const [teachers, existing, settings] = await Promise.all([
    Teacher.find(ACTIVE_TEACHER_FILTER).select("name teacherId expectedArrivalTime").sort({ name: 1 }).lean(),
    TeacherAttendance.find({ date: day }).lean(),
    getSettingsDoc(),
  ]);

  const byTeacher = {};
  existing.forEach((e) => { byTeacher[e.teacher.toString()] = e; });

  const roster = teachers.map((t) => {
    const rec = byTeacher[t._id.toString()] || null;
    return {
      teacher: t._id,
      name: t.name,
      teacherId: t.teacherId || "",
      arrivalTime: rec ? rec.arrivalTime : "",
      departureTime: rec ? rec.departureTime : "",
      workingMinutes: rec ? rec.workingMinutes : null,
      isLate: rec ? rec.isLate : false,
      lateMinutes: rec ? rec.lateMinutes : 0,
      // Provenance drives the "auto" badges in the marking UI; a missing
      // source on older records means manager-marked ("manual").
      arrivalSource: rec ? rec.arrivalSource || "manual" : "",
      departureSource: rec ? rec.departureSource || "manual" : "",
      // Drives the client late-preview: compared with the admin grace period.
      // "" → no expectation set → the preview shows "not checked", matching
      // the server rule that such teachers are never flagged.
      expectedArrivalTime: t.expectedArrivalTime || "",
      marked: !!rec,
    };
  });

  const markedRows = roster.filter((r) => r.marked);
  return responseStatus(res, 200, "success", {
    date,
    teachers: roster,
    settings: {
      lateDetectionEnabled: settings.lateDetectionEnabled,
      startTime: settings.startTime,
      graceMinutes: settings.graceMinutes,
    },
    summary: {
      marked: markedRows.length,
      totalTeachers: roster.length,
      totalMinutes: markedRows.reduce((s, r) => s + r.workingMinutes, 0),
      lateCount: markedRows.filter((r) => r.isLate).length,
    },
  });
};

// Lightweight teacher list for the history filter dropdown.
exports.getTeacherAttendanceTeachersService = async (res) => {
  const teachers = await Teacher.find(ACTIVE_TEACHER_FILTER)
    .select("name teacherId")
    .sort({ name: 1 })
    .lean();
  return responseStatus(res, 200, "success", teachers);
};

// ── automatic capture from login / logout ──────────────────────────────
// The primary way attendance is recorded: a teacher's FIRST login of the day
// fixes their arrival, their explicit LOGOUT fixes their departure. Both
// functions are best-effort for the caller — they must be wrapped in a
// try/catch so a capture hiccup can never break the auth flow itself.
// Precedence rule: an explicit manager/admin correction (source "manual",
// which older manager-written records also lack a source on → treated as
// manual) is NEVER overwritten by the auto paths.

/**
 * Record a teacher's login as their arrival for the day.
 * - no record yet           → create one (departure stays open until logout/marking)
 * - login-captured arrival  → keep the EARLIEST (re-logins never push it later)
 * - manager-marked arrival  → untouched
 * Returns the resulting record (or null on impossible input).
 */
exports.recordTeacherLoginArrival = async (teacherId, at = new Date()) => {
  const day = dayStartFromDate(at);
  const hhmm = hhmmFromDate(at);

  // A real teacher must exist (and not be withdrawn) — a forged/stale token
  // id must never fabricate attendance rows. The profile read also carries
  // the expected arrival time that the late flag is judged against (blank →
  // late detection is skipped for this teacher).
  const teacher = await Teacher.findOne({ _id: teacherId, isWithdrawn: { $ne: true } })
    .select("_id expectedArrivalTime")
    .lean();
  if (!teacher) return null;
  const expected = teacher.expectedArrivalTime || "";

  const settings = await getSettingsDoc();
  const existing = await TeacherAttendance.findOne({ teacher: teacherId, date: day }).lean();

  if (!existing) {
    const { isLate, lateMinutes } = computeLateFlag(hhmm, settings, expected);
    return TeacherAttendance.create({
      teacher: teacherId,
      date: day,
      arrivalTime: hhmm,
      departureTime: "",
      workingMinutes: 0,
      isLate,
      lateMinutes,
      arrivalSource: "login",
      // The login itself wrote the row — the teacher is its creator.
      createdBy: teacherId,
    });
  }

  // Manager-marked day → the human value wins; nothing to do.
  if (existing.arrivalSource !== "login") return existing;

  // Keep the earliest login of the day (only clock skew could beat it).
  if (timeToMinutes(hhmm) >= timeToMinutes(existing.arrivalTime)) return existing;

  const { isLate, lateMinutes } = computeLateFlag(hhmm, settings, expected);
  return TeacherAttendance.findByIdAndUpdate(
    existing._id,
    { $set: { arrivalTime: hhmm, isLate, lateMinutes, updatedBy: teacherId } },
    { new: true }
  );
};

/**
 * Record a teacher's explicit logout as their departure for the day.
 * - no record (or no arrival) → nothing to close; never fabricate a day
 * - manager-marked departure  → untouched
 * - otherwise                 → LAST logout wins (re-logins during the day)
 */
exports.recordTeacherLogoutDeparture = async (teacherId, at = new Date()) => {
  const day = dayStartFromDate(at);
  const hhmm = hhmmFromDate(at);

  const existing = await TeacherAttendance.findOne({ teacher: teacherId, date: day }).lean();
  if (!existing || !existing.arrivalTime) return null;
  if (existing.departureTime && existing.departureSource === "manual") return existing;

  const worked = computeWorkingMinutes(existing.arrivalTime, hhmm);
  return TeacherAttendance.findByIdAndUpdate(
    existing._id,
    {
      $set: {
        departureTime: hhmm,
        departureSource: "logout",
        // Same-minute login→logout (or skew) → 0; never negative.
        workingMinutes: worked === null ? 0 : worked,
        updatedBy: teacherId,
      },
    },
    { new: true }
  );
};

// ── history + working-hours totals (manager/admin) ──────────────────────────

/**
 * Date-wise records for a date range (both inclusive), optionally narrowed to
 * one teacher, plus the summed working hours the Phase 2 salary calc needs:
 * an overall summary and a per-teacher breakdown over the SAME range.
 */
exports.getTeacherAttendanceHistoryService = async (filters, res) => {
  const start = parseDayStart(filters.startDate);
  const end = parseDayStart(filters.endDate);
  if (!start || !end) {
    return responseStatus(res, 400, "failed", "Invalid date range — expected YYYY-MM-DD startDate and endDate");
  }
  if (start > end) {
    return responseStatus(res, 400, "failed", "startDate must not be after endDate");
  }
  const endExclusive = new Date(end);
  endExclusive.setDate(endExclusive.getDate() + 1); // include endDate itself

  const match = { date: { $gte: start, $lt: endExclusive } };
  if (filters.teacherId) {
    if (!mongoose.Types.ObjectId.isValid(filters.teacherId)) {
      return responseStatus(res, 400, "failed", "Invalid teacher id");
    }
    match.teacher = new mongoose.Types.ObjectId(filters.teacherId);
  }

  // Paged date-wise records (newest first).
  const { data, pagination } = await paginate(TeacherAttendance, match, {
    page: filters.page,
    limit: filters.limit,
    sort: "-date",
    populate: { path: "teacher", select: "name teacherId" },
  });

  // Overall totals + per-teacher totals over the whole range (not just the
  // current page) — two $group shapes on the same $match.
  const [totalsAgg, perTeacherAgg] = await Promise.all([
    TeacherAttendance.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalMinutes: { $sum: "$workingMinutes" },
          records: { $sum: 1 },
          lateCount: { $sum: { $cond: ["$isLate", 1, 0] } },
        },
      },
    ]),
    TeacherAttendance.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$teacher",
          totalMinutes: { $sum: "$workingMinutes" },
          days: { $sum: 1 },
          lateCount: { $sum: { $cond: ["$isLate", 1, 0] } },
        },
      },
      { $sort: { totalMinutes: -1 } },
    ]),
  ]);

  const totals = totalsAgg[0] || { totalMinutes: 0, records: 0, lateCount: 0 };

  // Resolve teacher names for the breakdown (populate can't run on $group ids).
  const teacherIds = perTeacherAgg.map((t) => t._id);
  const teacherDocs = teacherIds.length
    ? await Teacher.find({ _id: { $in: teacherIds } }).select("name teacherId").lean()
    : [];
  const nameById = {};
  teacherDocs.forEach((t) => { nameById[t._id.toString()] = t; });

  const perTeacher = perTeacherAgg.map((t) => {
    const doc = nameById[t._id.toString()];
    return {
      teacher: t._id,
      name: doc ? doc.name : "Unknown",
      teacherId: doc ? doc.teacherId || "" : "",
      days: t.days,
      totalMinutes: t.totalMinutes,
      totalHours: Math.round((t.totalMinutes / 60) * 100) / 100,
      lateCount: t.lateCount,
    };
  });

  return responseStatus(res, 200, "success", {
    range: {
      startDate: filters.startDate,
      endDate: filters.endDate,
      teacherId: filters.teacherId || "",
    },
    records: data,
    pagination,
    summary: {
      totalMinutes: totals.totalMinutes,
      totalHours: Math.round((totals.totalMinutes / 60) * 100) / 100,
      records: totals.records,
      lateCount: totals.lateCount,
    },
    perTeacher,
  });
};

// ── late-arrival rule (read: manager/admin · write: admin only) ─────────────

exports.getTeacherAttendanceSettingsService = async (res) => {
  const settings = await getSettingsDoc();
  return responseStatus(res, 200, "success", {
    lateDetectionEnabled: settings.lateDetectionEnabled,
    startTime: settings.startTime,
    graceMinutes: settings.graceMinutes,
    updatedBy: settings.updatedBy || null,
    updatedAt: settings.updatedAt || null,
  });
};

/**
 * Update the rule, then re-derive isLate/lateMinutes on EVERY existing
 * teacher-attendance record so the stored flags always match the current
 * rule (the flag is derived data, not a historical snapshot). Only the new
 * teacherattendances collection is touched — never any existing table.
 */
exports.updateTeacherAttendanceSettingsService = async (payload, adminId, res) => {
  const enabled = payload.lateDetectionEnabled === true;
  const startTime = payload.startTime;
  const graceMinutes = Number(payload.graceMinutes);

  if (!isValidTime(startTime)) {
    return responseStatus(res, 400, "failed", "Start time must be a HH:MM (24-hour) time");
  }
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 240) {
    return responseStatus(res, 400, "failed", "Grace period must be a whole number of minutes between 0 and 240");
  }

  const settings = await TeacherAttendanceSettings.findOneAndUpdate(
    { key: "default" },
    { $set: { lateDetectionEnabled: enabled, startTime, graceMinutes, updatedBy: adminId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  // Re-flag existing records under the new rule (changed rows only). The
  // threshold is each teacher's OWN expected arrival time from the staff
  // profile — a teacher without one is never late (flags get cleared).
  const teacherDocs = await Teacher.find({}).select("_id expectedArrivalTime").lean();
  const expectedByTeacher = {};
  teacherDocs.forEach((t) => { expectedByTeacher[String(t._id)] = t.expectedArrivalTime || ""; });

  const all = await TeacherAttendance.find({}).select("arrivalTime isLate lateMinutes teacher").lean();
  const ops = [];
  for (const rec of all) {
    const flag = computeLateFlag(rec.arrivalTime, settings, expectedByTeacher[String(rec.teacher)]);
    if (flag.isLate !== rec.isLate || flag.lateMinutes !== rec.lateMinutes) {
      ops.push({
        updateOne: {
          filter: { _id: rec._id },
          update: { $set: { isLate: flag.isLate, lateMinutes: flag.lateMinutes } },
        },
      });
    }
  }
  if (ops.length > 0) await TeacherAttendance.bulkWrite(ops);

  return responseStatus(res, 200, "success", {
    settings: {
      lateDetectionEnabled: settings.lateDetectionEnabled,
      startTime: settings.startTime,
      graceMinutes: settings.graceMinutes,
    },
    reflagged: ops.length,
  });
};