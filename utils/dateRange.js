/**
 * Shared inclusive local-calendar-day range bounds for date-filtered reads
 * (collections report, expense history, and future Phase 4 reporting).
 *
 * Convention (same as salary/attendance periods and the Phase 3 expense
 * history): a selected day means the LOCAL calendar day, and a from/to range
 * is INCLUSIVE on both ends — expressed as [from local midnight, to local
 * midnight + 1 day). `datePaid`/`date` values are real instants, so UTC
 * midnight bounds silently drop the final day's payments and any early-day
 * payments that fall before UTC midnight (e.g. 00:00–05:00 PKT).
 *
 * Always build date-range filters through these helpers — do not hand-roll
 * `new Date("YYYY-MM-DD")` (parses as UTC) or `$lte` on a day string.
 */

const { parseDayStart } = require("./teacherSalaryCalc");

// Start of the day AFTER d (server-local), for the exclusive upper bound.
const nextDay = (d) => {
  const n = new Date(d);
  n.setDate(n.getDate() + 1);
  return n;
};

// "YYYY-MM-DD" for the server-local today. Never toISOString().slice(0, 10) —
// that is the UTC day and shifts before local midnight catches up.
const todayKey = () => {
  const n = new Date();
  const mm = String(n.getMonth() + 1).padStart(2, "0");
  const dd = String(n.getDate()).padStart(2, "0");
  return `${n.getFullYear()}-${mm}-${dd}`;
};

/**
 * Optional "YYYY-MM-DD" from/to → Mongo date bounds for an inclusive local
 * range: { $gte: from local midnight, $lt: to local midnight + 1 day }.
 * Either side may be omitted (open-ended). Returns null when a PROVIDED
 * string is malformed / not a real calendar day — the caller decides the
 * error response. from > to is NOT rejected here (callers differ: expenses
 * 400s, collections returns an empty range); the bounds then match nothing.
 */
function dayRangeFilter(from, to) {
  const start = from ? parseDayStart(from) : null;
  const end = to ? parseDayStart(to) : null;
  if ((from && !start) || (to && !end)) return null;
  const filter = {};
  if (start) filter.$gte = start;
  if (end) filter.$lt = nextDay(end);
  return filter;
}

// One inclusive local day: [day local midnight, next local midnight).
const singleDayFilter = (day) => dayRangeFilter(day, day);

module.exports = { parseDayStart, nextDay, todayKey, dayRangeFilter, singleDayFilter };