// Unified filter cascade for the PDF report form.
//
// One implementation drives ALL three report panels (Result Sheet, Session
// Report Card, Analytics) so their filter UI can never drift. Each panel uses
// the exact same order and behaviour:
//
//   Session → Grade → Section → Student → Subject → Test
//
// Two independent funnels join on the report:
//   • Grade → Section → Student narrow WHICH PUPILS appear. Built from the
//     student options' data-grade / data-section, resolved server-side per pupil
//     via GET /pdf-reports/teacher-students (role-scoped: admin/manager get the
//     whole roster, a plain teacher only their assigned classes' pupils — so
//     every panel is scoped identically for every role).
//   • Session and Subject → Test narrow WHICH TESTS feed the report (data-session
//     / data-subject on the test options). Subject options are themselves already
//     role-scoped server-side (a teacher sees only assigned subjects).
//
// Each panel owns a distinct `<idp>-*` id set and a distinct `namep*` submit-name
// set (see views/reports/partials/filter-cascade.ejs). All three panels share ONE
// <form> and a hidden (display:none) control still submits, so per-panel prefixes
// keep the values from colliding. Every field is optional: the "All …" option
// (value "") means no narrowing. A choice that no longer matches after the
// filters above it tighten is cleared rather than submitted stale.
(function () {
  // PG first, then numeric ascending.
  function gradeSort(a, b) {
    var rank = function (g) { return g === 'PG' ? -1 : parseInt(g, 10); };
    return rank(a) - rank(b);
  }

  // Distinct {value,label} for a category across a set of items.
  function distinct(list, field, labelFn) {
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      var v = item[field];
      if (seen[v]) return;
      seen[v] = true;
      out.push({ value: v, label: labelFn(v) });
    });
    return out;
  }

  // Repopulate a rebuilt-from-scratch picker (Grade / Section), keeping a
  // still-valid previous choice; lock it when there is nothing to offer.
  function fillSelect(selectEl, placeholderLabel, items) {
    var previous = selectEl.value;
    selectEl.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = placeholderLabel;
    selectEl.appendChild(ph);
    items.forEach(function (it) {
      var opt = document.createElement('option');
      opt.value = it.value;
      opt.textContent = it.label;
      selectEl.appendChild(opt);
    });
    var stillValid = items.some(function (it) { return it.value === previous; });
    selectEl.value = stillValid && items.length > 1 ? previous : '';
    selectEl.disabled = items.length === 0;
  }

  // Repopulate a submit-bearing picker (Student / Test) from a filtered subset,
  // keeping its "All …" placeholder option and a still-valid previous choice.
  function refillWithOptions(selectEl, placeholder, items) {
    var previous = selectEl.value;
    selectEl.innerHTML = '';
    if (placeholder) selectEl.appendChild(placeholder);
    items.forEach(function (it) {
      var opt = document.createElement('option');
      opt.value = it.value;
      opt.textContent = it.label;
      selectEl.appendChild(opt);
    });
    selectEl.value = items.some(function (it) { return it.value === previous; }) ? previous : '';
  }

  // Wire one panel's six selects. Returns the test select so the caller can add
  // a panel-specific submit guard.
  function initCascade(idp) {
    var sessionSelect = document.getElementById(idp + '-session');
    var gradeSelect = document.getElementById(idp + '-grade');
    var sectionSelect = document.getElementById(idp + '-section');
    var studentSelect = document.getElementById(idp + '-student');
    var subjectSelect = document.getElementById(idp + '-subject');
    var testSelect = document.getElementById(idp + '-test');
    var countLine = document.getElementById(idp + '-test-count');
    if (!sessionSelect || !gradeSelect || !sectionSelect || !studentSelect || !subjectSelect || !testSelect) return null;

    // ── snapshots (rebuilt lists restore from these copies) ───────────────────
    var ALL_STUDENTS = Array.prototype.slice
      .call(studentSelect.querySelectorAll('option'))
      .filter(function (o) { return o.value !== ''; })
      .map(function (o) {
        return { value: o.value, label: o.textContent.trim(), grade: o.getAttribute('data-grade') || 'none', section: o.getAttribute('data-section') || 'none' };
      });
    var ALL_TESTS = Array.prototype.slice
      .call(testSelect.querySelectorAll('option'))
      .filter(function (o) { return o.value !== ''; })
      .map(function (o) {
        return { value: o.value, label: o.textContent.trim(), session: o.getAttribute('data-session'), subject: o.getAttribute('data-subject') };
      });
    var TOTAL_TESTS = ALL_TESTS.length;

    var studentPlaceholder = studentSelect.querySelector('option[value=""]');
    var testPlaceholder = testSelect.querySelector('option[value=""]');

    // ── student funnel: Grade → Section → Student ─────────────────────────────
    function rebuildGrades() {
      var items = distinct(ALL_STUDENTS, 'grade', function (g) { return g === 'none' ? 'No grade' : 'Grade ' + g; });
      items.sort(function (a, b) { return gradeSort(a.value, b.value); });
      fillSelect(gradeSelect, 'All grades', items);
      rebuildSections();
    }

    function rebuildSections() {
      var g = gradeSelect.value;
      var pool = g ? ALL_STUDENTS.filter(function (s) { return s.grade === g; }) : ALL_STUDENTS;
      fillSelect(sectionSelect, 'All sections', distinct(pool, 'section', function (s) { return s === 'none' ? 'No section' : s; }));
      rebuildStudents();
    }

    function rebuildStudents() {
      var g = gradeSelect.value;
      var sec = sectionSelect.value;
      var shown = ALL_STUDENTS.filter(function (s) {
        if (g && s.grade !== g) return false;
        if (sec && s.section !== sec) return false;
        return true;
      });
      refillWithOptions(studentSelect, studentPlaceholder, shown);
    }

    // ── test funnel: Session + Subject → Test ─────────────────────────────────
    function matchingTests() {
      var sessionId = sessionSelect.value;
      var subjectId = subjectSelect.value;
      return ALL_TESTS.filter(function (t) {
        if (sessionId && t.session !== sessionId) return false;
        if (subjectId && t.subject !== subjectId) return false;
        return true;
      });
    }

    function rebuildTests() {
      var shown = matchingTests();
      refillWithOptions(testSelect, testPlaceholder, shown);
      if (countLine) {
        var filtered = sessionSelect.value || subjectSelect.value;
        countLine.textContent = filtered
          ? 'Showing ' + shown.length + ' of ' + TOTAL_TESTS + ' tests.'
          : TOTAL_TESTS + ' tests grouped by session and subject.';
      }
    }

    // ── listeners ─────────────────────────────────────────────────────────────
    gradeSelect.addEventListener('change', rebuildSections);
    sectionSelect.addEventListener('change', rebuildStudents);
    sessionSelect.addEventListener('change', rebuildTests);
    subjectSelect.addEventListener('change', rebuildTests);

    // ── init ──────────────────────────────────────────────────────────────────
    rebuildGrades();
    rebuildTests();
    return testSelect;
  }

  var rsTest = initCascade('rs');
  initCascade('an');
  initCascade('sr');

  // A result sheet is generated for exactly one Test, so unlike the other two
  // panels its Test field cannot stay on "All tests". The generator's contract is
  // unchanged; this only mirrors the old mandatory "select a test" behaviour.
  var form = document.getElementById('pdfForm');
  if (form && rsTest) {
    form.addEventListener('submit', function (e) {
      var reportType = document.getElementById('reportType');
      if (!reportType || reportType.value !== 'result-sheet') return;
      if (!rsTest.value) {
        e.preventDefault();
        alert('Please select a Test — a result sheet is generated for one test.');
      }
    });
  }
})();
