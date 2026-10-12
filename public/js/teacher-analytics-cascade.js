/**
 * Teacher "My analytics" cascade: Session → Grade → Phase → Week → Subject → Test.
 *
 * Mirrors the PDF-reports cascade pattern (report-filter-cascade.js): the page
 * server-renders every option that is relevant to THIS teacher (built from the
 * teacher-scoped test snapshot), and this script narrows each dropdown purely
 * from the data-* keys on the rendered Test options — no API round-trip.
 * A level only ever shows options that actually contain one of the teacher's
 * tests within the current upstream selection; a choice that falls out of scope
 * is cleared rather than left stale. Every field is optional: "All …" (value
 * "") means no narrowing, and the form is only sent when Apply is clicked.
 */
(function () {
  var sessionSel = document.getElementById('ta-session');
  var gradeSel = document.getElementById('ta-grade');
  var phaseSel = document.getElementById('ta-phase');
  var weekSel = document.getElementById('ta-week');
  var subjectSel = document.getElementById('ta-subject');
  var testSel = document.getElementById('ta-test');
  if (!sessionSel || !gradeSel || !phaseSel || !weekSel || !subjectSel || !testSel) return;

  function snapshotOptions(sel) {
    return Array.prototype.slice
      .call(sel.options)
      .filter(function (o) { return o.value !== ''; })
      .map(function (o) {
        return {
          value: o.value,
          label: o.textContent.trim(),
          session: o.getAttribute('data-session') || '',
          phase: o.getAttribute('data-phase') || '',
          week: o.getAttribute('data-week') || '',
          subject: o.getAttribute('data-subject') || '',
          grades: (o.getAttribute('data-grade') || '').split(',').filter(Boolean),
        };
      });
  }

  // Full teacher-scoped lists — rebuilt dropdowns always restore from these.
  var TESTS = snapshotOptions(testSel);
  var GRADES = snapshotOptions(gradeSel);
  var PHASES = snapshotOptions(phaseSel);
  var WEEKS = snapshotOptions(weekSel);
  var SUBJ = snapshotOptions(subjectSel);

  function gradeSort(a, b) {
    var rank = function (g) { return g === 'PG' ? -1 : (parseInt(g, 10) || 9999); };
    return rank(a) - rank(b);
  }

  // Tests matching the current selections, up to (exclusive) the given depth:
  //   1 = session, 2 = +grade, 3 = +phase, 4 = +week.
  function pool(depth) {
    return TESTS.filter(function (t) {
      if (depth >= 1 && sessionSel.value && t.session !== sessionSel.value) return false;
      if (depth >= 2 && gradeSel.value && t.grades.indexOf(gradeSel.value) === -1) return false;
      if (depth >= 3 && phaseSel.value && t.phase !== phaseSel.value) return false;
      if (depth >= 4 && weekSel.value && t.week !== weekSel.value) return false;
      return true;
    });
  }

  // Distinct {value,label} for one key across a pool of tests, labels from the
  // server-rendered metadata list, ordered like that list.
  function distinct(poolTests, key, metaList) {
    var seen = {};
    poolTests.forEach(function (t) { if (t[key]) seen[t[key]] = true; });
    return metaList.filter(function (m) { return seen[m.value]; });
  }

  // Repopulate a picker from scratch, keeping a still-valid previous choice.
  function fillSelect(sel, placeholderLabel, items) {
    var previous = sel.value;
    sel.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = placeholderLabel;
    sel.appendChild(ph);
    items.forEach(function (it) {
      var opt = document.createElement('option');
      opt.value = it.value;
      opt.textContent = it.label;
      sel.appendChild(opt);
    });
    sel.value = items.some(function (it) { return it.value === previous; }) ? previous : '';
  }

  function rebuildGrades() {
    // Grades live in an array per test — expand manually.
    var seen = {};
    pool(1).forEach(function (t) { t.grades.forEach(function (g) { seen[g] = true; }); });
    var items = GRADES.filter(function (m) { return seen[m.value]; });
    items.sort(function (a, b) { return gradeSort(a.value, b.value); });
    fillSelect(gradeSel, 'All grades', items);
  }

  function rebuildPhases() { fillSelect(phaseSel, 'All phases', distinct(pool(2), 'phase', PHASES)); }
  function rebuildWeeks() { fillSelect(weekSel, 'All weeks', distinct(pool(3), 'week', WEEKS)); }
  function rebuildSubjects() { fillSelect(subjectSel, 'All my subjects', distinct(pool(4), 'subject', SUBJ)); }

  function rebuildTests() {
    var subjectId = subjectSel.value;
    var shown = pool(4).filter(function (t) { return !subjectId || t.subject === subjectId; });
    fillSelect(testSel, 'All tests', shown);
  }

  // Changing any level re-narrows everything below it.
  function rebuildFromSession() { rebuildGrades(); rebuildPhases(); rebuildWeeks(); rebuildSubjects(); rebuildTests(); }
  function rebuildFromGrade() { rebuildPhases(); rebuildWeeks(); rebuildSubjects(); rebuildTests(); }
  function rebuildFromPhase() { rebuildWeeks(); rebuildSubjects(); rebuildTests(); }
  function rebuildFromWeek() { rebuildSubjects(); rebuildTests(); }

  sessionSel.addEventListener('change', rebuildFromSession);
  gradeSel.addEventListener('change', rebuildFromGrade);
  phaseSel.addEventListener('change', rebuildFromPhase);
  weekSel.addEventListener('change', rebuildFromWeek);
  subjectSel.addEventListener('change', rebuildTests);

  // Initialise: the server-rendered (restored) selections are kept as long as
  // they remain valid inside the snapshot — which they always are, since the
  // snapshot is the unfiltered teacher scope.
  rebuildFromSession();
})();
