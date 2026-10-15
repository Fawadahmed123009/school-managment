/**
 * Admission date (Student.dateAdmitted) parsing, validation and display.
 *
 * `dateAdmitted` is a calendar DATE, not a timestamp, and it is load-bearing:
 * the day-granular test-roster cutoff in utils/testRosterEligibility.js drops
 * pupils admitted AFTER a test was held from that test's marking roster, marks
 * audit expected counts and marking follow-up. Storing a raw form string would
 * either throw on the Date column or, worse, keep a garbage date that silently
 * hides a pupil from every test roster before it.
 *
 * The stored value is UTC midnight of the picked day. That keeps every consumer
 * on the same calendar day in the school's timezone (Asia/Karachi, UTC+5):
 *   • list / export columns render it as the picked day,
 *   • `toISOString().slice(0, 10)` in the Excel export round-trips exactly,
 *   • comparisons against a test's local-day cutoff have a whole-day margin,
 *     never a hair's-breadth time-of-day artefact.
 *
 * A date is accepted when it is a real calendar date inside a plausible window.
 * "Plausible" is deliberately generous: a school may legitimately register a
 * pupil who joins later this term (a near-future admission), so only clearly
 * impossible values — a rolled-over day like 2026-02-30, a century-old or
 * far-future typo — are rejected.
 */

const { localDateKey } = require("./localDateKey");

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// Anything before this is a typo, not a pupil.
const MIN_YEAR = 1900;
// Pre-registering for the next academic year is legitimate; further out is a
// mistake that would hide the pupil from every roster in the meantime.
const MAX_FUTURE_DAYS = 366;

// School-local calendar day, "YYYY-MM-DD".
const todayKey = () => localDateKey(new Date());

/**
 * Normalize whatever a form/API sent for `dateAdmitted` into a storable Date.
 *
 * Returns { ok: true, date } where `date` is:
 *   • a Date at UTC midnight of the picked day, or
 *   • undefined when the field was absent/blank — callers then keep the model
 *     default (registration) or leave the recorded value untouched (edit).
 * Or { ok: false, message } when the value is not a usable admission date.
 */
exports.normalizeAdmissionDate = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    return { ok: true, date: undefined };
  }

  // Date instances (programmatic callers / model round-trips) are reduced to
  // their school-local calendar day so the stored shape stays day-granular.
  const raw =
    value instanceof Date
      ? Number.isFinite(value.getTime())
        ? localDateKey(value)
        : ""
      : String(value).trim();

  const match = DATE_ONLY.exec(raw);
  if (!match) {
    return { ok: false, message: "Admission date must be a calendar date in YYYY-MM-DD format." };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls impossible days over (2026-02-30 → 2026-03-02); reject those
  // rather than quietly saving a different day from the one that was typed.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, message: "Admission date is not a real calendar date." };
  }

  if (year < MIN_YEAR) {
    return { ok: false, message: `Admission date can't be earlier than ${MIN_YEAR}-01-01.` };
  }

  const [ty, tm, td] = todayKey().split("-").map(Number);
  const horizon = new Date(Date.UTC(ty, tm - 1, td + MAX_FUTURE_DAYS));
  if (date.getTime() > horizon.getTime()) {
    return {
      ok: false,
      message: `Admission date can't be more than ${MAX_FUTURE_DAYS} days in the future.`,
    };
  }

  return { ok: true, date };
};

/**
 * Value for an `<input type="date">`. Uses the school-local day so the picker
 * always shows the same date the roster table displays. Returns "" when no
 * usable date is recorded (the picker then starts blank / falls back).
 */
exports.admissionDateInputValue = (value) => {
  if (value === undefined || value === null || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return localDateKey(date);
};

/** Default admission date for a fresh registration: the school's today. */
exports.todayAdmissionDate = () => todayKey();
