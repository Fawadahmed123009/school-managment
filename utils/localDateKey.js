/**
 * Single source of truth for attendance day / date keys.
 *
 * Attendance documents are written at server-LOCAL midnight
 * (`day.setHours(0, 0, 0, 0)` on the marking paths), which for Asia/Karachi
 * is 19:00Z of the PREVIOUS UTC day. MongoDB's $dateToString defaults to UTC,
 * so grouping on it without an explicit timezone buckets every record one day
 * early. Same trap with `date.toISOString().slice(0, 10)` in JS.
 *
 * Always go through these helpers for attendance-day keys — do not hand-roll
 * $dateToString or UTC ISO slicing, this bug class is silent (off-by-one day).
 */

const LOCAL_TZ = "Asia/Karachi";

// $dateToString stage that formats a date in the school's local calendar.
// Use inside aggregation $group _id expressions for daily keys.
const dateKeyStage = (format = "%Y-%m-%d", date = "$date") => ({
  $dateToString: { format, date, timezone: LOCAL_TZ },
});

// JS-side equivalent of dateKeyStage(): Date → "YYYY-MM-DD" in LOCAL_TZ.
const _dayParts = new Intl.DateTimeFormat("en-US", {
  timeZone: LOCAL_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const localDateKey = (date) => {
  const parts = _dayParts.formatToParts(date instanceof Date ? date : new Date(date));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};

module.exports = { LOCAL_TZ, dateKeyStage, localDateKey };
