const responseStatus = require("../../handlers/responseStatus.handler");
const Student = require("../../models/Students/students.model");
const Attendance = require("../../models/Academic/attendance.model");
const TestResult = require("../../models/Academic/testResult.model");
const Fees = require("../../models/Fees/fees.model");
const { localDateKey, LOCAL_TZ } = require("../../utils/localDateKey");

exports.getStudentAnalysisService = async (studentId, res) => {
  const student = await Student.findById(studentId).populate("classLevel", "name gradeLevel group section");
  if (!student) return responseStatus(res, 404, "failed", "Student not found");

  // ---- Attendance ----
  const attendanceRecords = await Attendance.find({ student: studentId });
  const attendanceTotals = { present: 0, absent: 0, late: 0 };
  attendanceRecords.forEach((r) => { attendanceTotals[r.status]++; });
  const totalMarked = attendanceRecords.length;
  const attendancePercent = totalMarked > 0
    ? Math.round(((attendanceTotals.present + attendanceTotals.late) / totalMarked) * 10000) / 100
    : null;

  // ---- Current-month attendance (pie chart) ----
  // Bucket the already-loaded records by LOCAL calendar month via localDateKey —
  // attendance docs are written at server-LOCAL midnight (Asia/Karachi), so a
  // UTC month key (toISOString/getMonth on the raw date) would silently shift
  // early-month records into the previous month. See utils/localDateKey.js.
  const monthKey = localDateKey(new Date()).slice(0, 7); // "YYYY-MM", school TZ
  const monthTotals = { present: 0, absent: 0, late: 0 };
  let monthMarked = 0;
  attendanceRecords.forEach((r) => {
    if (!r.date) return;
    if (localDateKey(r.date).slice(0, 7) !== monthKey) return;
    if (monthTotals[r.status] === undefined) return; // unknown status never counts
    monthTotals[r.status]++;
    monthMarked++;
  });
  const monthPercent = monthMarked > 0
    ? Math.round(((monthTotals.present + monthTotals.late) / monthMarked) * 10000) / 100
    : null;
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: LOCAL_TZ })
    .format(new Date());

  // ---- Test results, grouped by session ----
  const testResults = await TestResult.find({ student: studentId })
    .populate({
      path: "test",
      populate: [
        { path: "subject", select: "name displayName" },
        { path: "session", select: "name" },
        // Week metadata (name + startDate) drives the subject-grouped results
        // below, where each subject's tests are ordered chronologically by week.
        { path: "week", select: "name startDate" },
      ],
    });

  // Group by session name (or "Standalone tests" for tests with no session).
  // Same pattern as the session report card: results keyed by session, each
  // row carries score/totalMarks/percent like the analytics endpoint.
  // An ABSENT mark now counts as a real 0% toward every average here (its stored
  // score is 0, so score/totalMarks is 0) — included in the denominator and
  // dragging the average down, exactly like a genuine typed 0. The `absent` flag
  // is still carried per row so the UI can render "A" for the cell while the
  // number behind it is 0. (Result-sheet / analytics PDFs and the dashboard
  // score scope still EXCLUDE absences — a different code path.)
  const bySession = {};
  testResults.forEach((r) => {
    const test = r.test;
    if (!test) return; // orphaned result (test deleted)

    const sessionName = test.session ? test.session.name : "Standalone tests";
    if (!bySession[sessionName]) bySession[sessionName] = [];

    const absent = r.absent === true;
    const percent = test.totalMarks
      ? Math.round((r.score / test.totalMarks) * 10000) / 100
      : null;

    bySession[sessionName].push({
      test: test.name,
      // Display label for the per-test table. The subject-wise aggregation
      // below still keys off test.subject.name (see subjectAgg) so program-
      // split subjects stay separate in averages and charts.
      subject: test.subject ? (test.subject.displayName || test.subject.name) : "Unknown",
      date: test.date,
      score: r.score,
      absent,
      totalMarks: test.totalMarks,
      percent,
    });
  });

  // Sort each group's tests by date (ascending) + compute per-session average
  const sessionSummaries = Object.keys(bySession).map((sessionName) => {
    const tests = bySession[sessionName].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    const validPercents = tests.filter((t) => t.percent !== null);
    const average =
      validPercents.length > 0
        ? Math.round(
            (validPercents.reduce((sum, t) => sum + t.percent, 0) /
              validPercents.length) *
              100
          ) / 100
        : null;
    return { session: sessionName, tests, average };
  });

  // Overall average: an absence counts as 0% here (score 0 / totalMarks), so it
  // enters the denominator and drags the average down — same rule as the
  // sessions, subjects, trends and the at-risk service on this path.
  const allPercents = testResults
    .filter((r) => r.test && r.test.totalMarks)
    .map((r) => Math.round((r.score / r.test.totalMarks) * 10000) / 100);
  const overallAverage =
    allPercents.length > 0
      ? Math.round(
          (allPercents.reduce((sum, p) => sum + p, 0) / allPercents.length) * 100
        ) / 100
      : null;

  // ---- Subject-wise aggregation (average % per subject, across all sessions) ----
  // The per-session tables list each test as a raw row, so a subject repeats
  // across rows. Roll those up here so the UI can show one average per subject
  // instead of a flat, repeating column. Absences count as 0% (included in the
  // denominator and dragging the subject average down) — same rule as above.
  const subjectAgg = {};
  testResults.forEach((r) => {
    const test = r.test;
    if (!test || !test.totalMarks) return;
    const subjectName = test.subject ? test.subject.name : "Unknown";
    const percent = Math.round((r.score / test.totalMarks) * 10000) / 100;
    if (!subjectAgg[subjectName]) {
      subjectAgg[subjectName] = {
        total: 0,
        count: 0,
        // Chart / alert display label — `displayName || name` convention from
        // the subject-naming work. Keying stays on raw `name` (above) so
        // program-split subjects sharing a displayName remain separate.
        label: test.subject ? (test.subject.displayName || test.subject.name) : "Unknown",
      };
    }
    subjectAgg[subjectName].total += percent;
    subjectAgg[subjectName].count += 1;
  });
  const bySubject = Object.keys(subjectAgg)
    .map((subject) => ({
      subject,
      label: subjectAgg[subject].label,
      count: subjectAgg[subject].count,
      average:
        Math.round((subjectAgg[subject].total / subjectAgg[subject].count) * 100) / 100,
    }))
    .sort((a, b) => b.average - a.average);

  // ---- Results grouped by Subject, tests ordered by Week ----
  // The View Student page presents results as one collapsible panel per subject
  // (labelled with displayName, consistent with the subject-naming work) with
  // that subject's tests ordered chronologically by week. The per-session
  // grouping above stays untouched (the progress chart keys off it). Absent rows
  // keep `absent` + score so the UI can render "A" / "0"; on THIS page an absence
  // still counts as 0% in every average (same rule as the sessions and subjects).
  const subjectGroupsMap = {};
  testResults.forEach((r) => {
    const test = r.test;
    if (!test) return; // orphaned result (test deleted)
    const subjectKey = test.subject ? test.subject.name : "Unknown";
    const label = test.subject ? (test.subject.displayName || test.subject.name) : "Unknown";
    const absent = r.absent === true;
    const percent = test.totalMarks
      ? Math.round((r.score / test.totalMarks) * 10000) / 100
      : null;
    const wk = test.week || null;
    if (!subjectGroupsMap[subjectKey]) subjectGroupsMap[subjectKey] = { label, tests: [] };
    subjectGroupsMap[subjectKey].tests.push({
      test: test.name,
      date: test.date,
      score: r.score,
      absent,
      totalMarks: test.totalMarks,
      percent,
      weekName: wk ? wk.name : null,
      weekStart: wk ? wk.startDate : null,
    });
  });

  const subjectGroups = Object.keys(subjectGroupsMap)
    .map((key) => {
      const group = subjectGroupsMap[key];
      // Order by week start (chronological). A test with no week falls back to
      // its own date so it stays time-placed rather than jumping to the top; a
      // test with neither sinks to the bottom. Ties broken by test date.
      const orderKey = (t) => {
        if (t.weekStart) return new Date(t.weekStart).getTime();
        if (t.date) return new Date(t.date).getTime();
        return Number.MAX_SAFE_INTEGER;
      };
      group.tests.sort((a, b) => {
        const ka = orderKey(a);
        const kb = orderKey(b);
        if (ka !== kb) return ka - kb;
        return new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
      });
      // Header pill: subject average % across its tests (absent-as-0 rule).
      const pcts = group.tests.filter((t) => t.percent !== null).map((t) => t.percent);
      const average =
        pcts.length > 0
          ? Math.round((pcts.reduce((s, p) => s + p, 0) / pcts.length) * 100) / 100
          : null;
      return { subject: key, label: group.label, tests: group.tests, average };
    })
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));

  // ---- Progress series (per-session average %, ordered chronologically) ----
  // The per-session averages above are only surfaced as pills today; expose them
  // as a time-ordered series so the UI can plot a progress trend chart.
  const progress = sessionSummaries
    .filter((s) => s.average !== null)
    .map((s) => ({
      session: s.session,
      average: s.average,
      // tests within a session are sorted ascending by date, so [0] is earliest
      date: s.tests.length ? s.tests[0].date : null,
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // ---- Fees ----
  const feeRecords = await Fees.find({ student: studentId }).populate("feeHead", "name");
  const feeTotals = { total: 0, paid: 0, pending: 0 };
  feeRecords.forEach((f) => {
    feeTotals.total += f.amount;
    if (f.status === "paid") feeTotals.paid += f.amount;
    else feeTotals.pending += f.amount;
  });

  return responseStatus(res, 200, "success", {
    student: {
      _id: student._id,
      name: student.name,
      studentId: student.studentId,
      classLevel: student.classLevel,
      photoUrl: student.photoUrl,
      // Parent-facing contact number — same field every existing WhatsApp
      // feature targets (fee reminders, at-risk rows, PDF report sharing).
      whatsappNumber: student.whatsappNumber || "",
    },
    attendance: {
      totalMarked,
      ...attendanceTotals,
      percent: attendancePercent,
      currentMonth: {
        monthKey,
        monthLabel,
        totalMarked: monthMarked,
        ...monthTotals,
        percent: monthPercent,
      },
    },
    marks: {
      overallAverage,
      bySession: sessionSummaries,
      bySubject,
      subjectGroups,
      progress,
    },
    fees: {
      ...feeTotals,
      records: feeRecords,
    },
  });
};
