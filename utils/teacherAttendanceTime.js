/**
 * Pure time helpers for teacher (staff) attendance — Phase 1.
 *
 * Arrival/departure are stored as "HH:MM" 24-hour strings (to the minute).
 * Working minutes and the late flag are DERIVED from them; keeping the math
 * here (no DB, no res) makes it unit-testable and gives the marking service,
 * the settings re-flag pass and any Phase 2 salary code one source of truth.
 */

// Strict "HH:MM" 24-hour clock, to the minute.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isValidTime = (str) => typeof str === "string" && TIME_RE.test(str);

// "HH:MM" → minutes since midnight. Caller validates first (NaN otherwise).
const timeToMinutes = (str) => {
  if (!isValidTime(str)) return NaN;
  const [h, m] = str.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Minutes worked between arrival and departure (same-day shifts only).
 * Returns null when either time is invalid or departure is not strictly
 * after arrival — the service turns that into a 400, never a negative store.
 */
const computeWorkingMinutes = (arrival, departure) => {
  const a = timeToMinutes(arrival);
  const d = timeToMinutes(departure);
  if (Number.isNaN(a) || Number.isNaN(d) || d <= a) return null;
  return d - a;
};

/**
 * Late flag for an arrival under the admin-configured rule, judged against
 * the teacher's OWN expected arrival time (staff profile field — the global
 * settings.startTime is NOT used here).
 * Late = arrival strictly later than expectedArrival + graceMinutes.
 * Disabled (or missing) settings → never late. NO expected time (or an
 * invalid one) → never late: lateness is SKIPPED until the profile is
 * filled in, so there are no false positives against a global default.
 * Returns { isLate, lateMinutes } where lateMinutes is the overshoot past
 * the threshold (0 when not late).
 */
const computeLateFlag = (arrival, settings, expectedArrival) => {
  if (!settings || !settings.lateDetectionEnabled) {
    return { isLate: false, lateMinutes: 0 };
  }
  const a = timeToMinutes(arrival);
  const exp = timeToMinutes(expectedArrival);
  if (Number.isNaN(a) || Number.isNaN(exp)) {
    return { isLate: false, lateMinutes: 0 };
  }
  const grace = Number(settings.graceMinutes) || 0;
  const overshoot = a - (exp + grace);
  return overshoot > 0
    ? { isLate: true, lateMinutes: overshoot }
    : { isLate: false, lateMinutes: 0 };
};

// Display helper: 450 → "7h 30m", 45 → "45m", 0 → "0m".
const formatMinutes = (mins) => {
  const n = Math.max(0, Math.round(Number(mins) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
};

// Date → "HH:MM" from the LOCAL clock (login/logout capture timestamps a
// live instant; attendance stores to-the-minute local times).
const hhmmFromDate = (at) =>
  `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

// Date → Date at its server-LOCAL midnight (same convention as the
// attendance `date` bucket — see utils/localDateKey.js).
const dayStartFromDate = (at) => {
  const d = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  d.setHours(0, 0, 0, 0);
  return d;
};

module.exports = {
  TIME_RE,
  isValidTime,
  timeToMinutes,
  computeWorkingMinutes,
  computeLateFlag,
  formatMinutes,
  hhmmFromDate,
  dayStartFromDate,
};