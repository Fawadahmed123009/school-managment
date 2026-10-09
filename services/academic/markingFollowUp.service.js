/**
 * Marking Follow-up Service
 *
 * Answers "which past-dated tests still have students left to mark?" for every
 * teacher at once, so an admin (or an attendance manager, who gets the admin
 * dashboard) can chase up outstanding marking across the whole staff.
 *
 *   • getPendingMarkingAllTeachers() → [{ _id, name, teacher, teacherId,
 *       subject, classes, date, expected, marked }, …]
 *
 * A test counts as pending for a teacher when ALL of these hold:
 *   1. the test date has passed;
 *   2. the teacher is assigned that test's subject;
 *   3. the test covers at least one class the teacher is assigned to;
 *   4. fewer than the expected number of non-withdrawn students in those
 *      in-scope classes have a TestResult for the test.
 *
 * The scoping rules deliberately mirror the teacher's own dashboard
 * (routes/views/dashboard.views.js) and therefore the roster shown at
 * /tests/mark/:id, so the "marked/expected" subtotal an admin sees is exactly
 * what the teacher sees when they open the test to grade it.  When a test spans
 * several classes, only the teacher's assigned classes are counted — a colleague
 * covering another class appears as their own row.
 */

const Assignment = require("../../models/Academic/assignment.model");
const Teacher = require("../../models/Staff/teachers.model");
const Student = require("../../models/Students/students.model");
const Test = require("../../models/Academic/test.model");
const TestResult = require("../../models/Academic/testResult.model");

const asId = (ref) => (ref && ref._id ? String(ref._id) : ref ? String(ref) : null);

// Inclusive upper bound on a student's admission date for them to belong to a
// test (see services/academic/test.service.js). Day-granular so a same-day
// admission is never wrongly dropped. Returns null when the test has no usable
// date — the caller then applies no admission filter.
function admissionCutoffForTest(testDate) {
  if (!testDate) return null;
  const d = new Date(testDate);
  if (isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Fetch every past-dated test as one lookup array. */
async function loadPastDatedTests() {
  return Test.find({ date: { $lt: new Date() } })
    .select("name subject classLevels date")
    .populate("subject", "name")
    .populate("classLevels", "name")
    .lean();
}

/**
 * Pending marking rows for the whole staff, oldest (most overdue) test first.
 */
async function getPendingMarkingAllTeachers() {
  const [assignments, tests, students, results, teachers] = await Promise.all([
    Assignment.find().populate("subject", "name").populate("classLevel", "name").lean(),
    loadPastDatedTests(),
    Student.find({ isWithdrawn: { $ne: true } }).select("_id classLevel dateAdmitted").lean(),
    TestResult.find().select("test student").lean(),
    Teacher.find().select("name").lean(),
  ]);

  const teacherNames = {};
  teachers.forEach((t) => {
    teacherNames[String(t._id)] = t.name;
  });

  // class level → its non-withdrawn students, the pool each teacher is expected
  // to have marked. Each entry keeps the pupil's admission date so the expected
  // count per test can drop anyone admitted AFTER that test was held (they
  // weren't in the class yet, so marking them is never outstanding).
  const studentsByClass = {};
  students.forEach((s) => {
    const cid = asId(s.classLevel);
    if (!cid) return;
    (studentsByClass[cid] || (studentsByClass[cid] = [])).push({
      id: String(s._id),
      admitted: s.dateAdmitted || null,
    });
  });

  // test → ids of students who already have a result.
  const markedByTest = {};
  results.forEach((r) => {
    const tid = asId(r.test);
    if (!tid) return;
    (markedByTest[tid] || (markedByTest[tid] = new Set())).add(asId(r.student));
  });

  // teacher → subject → the classes that teacher is responsible for marking.
  const duties = {}; // teacherId → { subjectId: { name, classLevelIds:Set } }
  const classNameById = {};
  assignments.forEach((a) => {
    const tid = asId(a.teacher);
    const sid = asId(a.subject);
    const cid = asId(a.classLevel);
    if (!tid || !sid || !cid) return;
    if (a.classLevel && a.classLevel.name) classNameById[cid] = a.classLevel.name;
    const bySubject = duties[tid] || (duties[tid] = {});
    if (!bySubject[sid]) bySubject[sid] = { name: (a.subject && a.subject.name) || "Unknown", classLevelIds: new Set() };
    bySubject[sid].classLevelIds.add(cid);
  });

  const pending = [];
  Object.entries(duties).forEach(([tid, bySubject]) => {
    Object.entries(bySubject).forEach(([sid, duty]) => {
      tests.forEach((t) => {
        if (asId(t.subject) !== sid) return;
        // Only the classes this teacher covers count towards their subtotal.
        const inScope = (t.classLevels || []).map(asId).filter((cid) => cid && duty.classLevelIds.has(cid));
        if (inScope.length === 0) return;
        // Only pupils already admitted by the test's date count towards this
        // teacher's expected pool for it.
        const admissionCutoff = admissionCutoffForTest(t.date);
        const expectedIds = inScope.flatMap((cid) =>
          (studentsByClass[cid] || [])
            .filter((s) => !admissionCutoff || !s.admitted || new Date(s.admitted) <= admissionCutoff)
            .map((s) => s.id)
        );
        if (expectedIds.length === 0) return;
        const markedSet = markedByTest[String(t._id)] || new Set();
        const marked = expectedIds.reduce((n, id) => n + (markedSet.has(id) ? 1 : 0), 0);
        if (marked >= expectedIds.length) return;
        pending.push({
          _id: t._id,
          name: t.name,
          teacherId: tid,
          teacher: teacherNames[tid] || "Unknown",
          subject: duty.name,
          classes: inScope.map((cid) => classNameById[cid]).filter(Boolean).join(", "),
          date: t.date,
          expected: expectedIds.length,
          marked,
        });
      });
    });
  });

  // Most overdue first, then by teacher so a person's list reads together.
  pending.sort((a, b) => new Date(a.date) - new Date(b.date) || a.teacher.localeCompare(b.teacher));
  return pending;
}

/**
 * Per-teacher test-marking summary for the whole staff.
 *
 * For every teacher we count the tests they are responsible for that have
 * already been held (past-dated, in-scope classes with at least one expected
 * student), and how many of those are FULLY marked — same scoping rules as
 * getPendingMarkingAllTeachers above, so the "total − marked" gap equals the
 * rows shown in the follow-up table.
 *
 * → [{ teacher, teacherId, total, marked }, …] sorted by workload (total desc).
 */
async function getTeacherTestMarkingSummary() {
  const [assignments, tests, students, results, teachers] = await Promise.all([
    Assignment.find().populate("subject", "name").populate("classLevel", "name").lean(),
    loadPastDatedTests(),
    Student.find({ isWithdrawn: { $ne: true } }).select("_id classLevel dateAdmitted").lean(),
    TestResult.find().select("test student").lean(),
    Teacher.find().select("name").lean(),
  ]);

  const teacherNames = {};
  teachers.forEach((t) => {
    teacherNames[String(t._id)] = t.name;
  });

  const studentsByClass = {};
  students.forEach((s) => {
    const cid = asId(s.classLevel);
    if (!cid) return;
    (studentsByClass[cid] || (studentsByClass[cid] = [])).push({
      id: String(s._id),
      admitted: s.dateAdmitted || null,
    });
  });

  const markedByTest = {};
  results.forEach((r) => {
    const tid = asId(r.test);
    if (!tid) return;
    (markedByTest[tid] || (markedByTest[tid] = new Set())).add(asId(r.student));
  });

  // teacher → subject → the classes that teacher is responsible for marking.
  const duties = {}; // teacherId → { subjectId: Set(classLevelIds) }
  assignments.forEach((a) => {
    const tid = asId(a.teacher);
    const sid = asId(a.subject);
    const cid = asId(a.classLevel);
    if (!tid || !sid || !cid) return;
    const bySubject = duties[tid] || (duties[tid] = {});
    if (!bySubject[sid]) bySubject[sid] = new Set();
    bySubject[sid].add(cid);
  });

  const summary = {};
  Object.entries(duties).forEach(([tid, bySubject]) => {
    let total = 0;
    let marked = 0;
    Object.entries(bySubject).forEach(([sid, classIds]) => {
      tests.forEach((t) => {
        // A test has a single subject, so it is matched for at most one duty.
        if (asId(t.subject) !== sid) return;
        const inScope = (t.classLevels || []).map(asId).filter((cid) => cid && classIds.has(cid));
        if (inScope.length === 0) return;
        const admissionCutoff = admissionCutoffForTest(t.date);
        const expectedIds = inScope.flatMap((cid) =>
          (studentsByClass[cid] || [])
            .filter((s) => !admissionCutoff || !s.admitted || new Date(s.admitted) <= admissionCutoff)
            .map((s) => s.id)
        );
        if (expectedIds.length === 0) return;
        total++;
        const markedSet = markedByTest[String(t._id)] || new Set();
        const markedCount = expectedIds.reduce((n, id) => n + (markedSet.has(id) ? 1 : 0), 0);
        if (markedCount >= expectedIds.length) marked++;
      });
    });
    if (total > 0) {
      summary[tid] = { teacher: teacherNames[tid] || "Unknown", teacherId: tid, total, marked };
    }
  });

  return Object.values(summary).sort(
    (a, b) => b.total - a.total || a.teacher.localeCompare(b.teacher)
  );
}

module.exports = { getPendingMarkingAllTeachers, getTeacherTestMarkingSummary };
