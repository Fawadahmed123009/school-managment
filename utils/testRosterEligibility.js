/**
 * Test-roster eligibility by admission date.
 *
 * A pupil who was admitted to a class AFTER a test was held did not sit that
 * test, so they must not be offered for marking and must not count towards the
 * school's expectation of how many scores the test should have.
 *
 * The rule lives here because every surface that measures a test against its
 * class must agree, or the panels contradict each other:
 *   • the mark-entry roster + score submission (services/academic/test.service.js)
 *   • the admin marks audit (same file)
 *   • marking follow-up / per-teacher summaries (services/academic/markingFollowUp.service.js)
 *   • the teacher dashboard's overdue-marking panel (routes/views/dashboard.views.js)
 *
 * The cutoff is deliberately DAY-granular: admissions and test dates are
 * recorded as calendar dates by the school, so someone admitted on the test's
 * own day was in the class and stays eligible. A pupil with no recorded
 * admission date (legacy rows) is always treated as eligible — the rule only
 * ever excludes a strictly-later admission, never an unknown one.
 */

/**
 * Inclusive upper bound on a student's admission date for them to belong to a
 * test. Returns the end of the test's local calendar day, or null when the test
 * carries no usable date (callers then apply no admission filter at all).
 */
exports.admissionCutoffForTest = (testDate) => {
  if (!testDate) return null;
  const d = new Date(testDate);
  if (isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
};

/**
 * Was this pupil in the class by the test's day? `cutoff` comes from
 * {@link admissionCutoffForTest}; a null cutoff (untestable test date) or a
 * null/missing admission date both keep the pupil.
 */
exports.isAdmittedByTest = (dateAdmitted, cutoff) => {
  if (!cutoff) return true;
  if (!dateAdmitted) return true;
  return new Date(dateAdmitted) <= cutoff;
};
