// Unified filter cascade for the PDF report form.
//
// One implementation drives ALL three report panels (Result Sheet, Session
// Report Card, Analytics) so their filter UI can never drift. Each panel uses
// the exact same order and behaviour — ONE data-driven chain, not visual
// grouping:
//
//   Session → Grade → Section → Student → Subject → Test
//
// How each dropdown is narrowed by the real data above it:
//   • Session → classes: every test option carries the ClassLevel ids it
//     targets (data-classes); a chosen session therefore resolves to the set
//     of classes its tests actually cover. The classLevelId → {grade, section}
//     map is embedded once (#report-class-scope, see views/reports/generate.ejs).
//   • Grade / Section / Student: a pupil links into that covered set through
//     their own class (data-class on the student options, from
//     GET /pdf-reports/teacher-students — role-scoped server-side, so a plain
//     teacher only ever sees assigned-class pupils). With no session picked the
//     whole scoped roster is offered, exactly as before.
//   • Subject: lists only subjects that have at least one test in the current
//     session + grade + section scope (the server-rendered list is the
//     starting snapshot; "All subjects" always stays).
//   • Test: session + grade + section + subject all narrow it together.
//
// Changing any dropdown rebuilds everything below it in the chain; a choice
// that no longer matches after the filters above it tighten is cleared rather
// than submitted stale, and a still-valid choice is kept.
//
// Each panel owns a distinct `<idp>-*` id set and a distinct `namep*` submit-name
// set (see views/reports/partials/filter-cascade.ejs). All three panels share ONE
// <form> and a hidden (display:none) control still submits, so per-panel prefixes
// keep the values from colliding. Every field is optional: the "All …" option
// (value "") means no narrowing.
(function () {
  // classLevelId → { grade, section }, embedded by the view. Missing entry
  // (class deleted between render and click) degrades to 'none', never throws.
  var CLASS_SCOPE = {};
  try {
    var scopeEl = document.getElementById('report-class-scope');
    CLASS_SCOPE = scopeEl ? JSON.parse(scopeEl.textContent) : {};
  } catch (e) { CLASS_SCOPE = {}; }

  var GRADE_NONE = 'none';
  var SECTION_NONE = 'none';

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

  // Repopulate a rebuilt-from-scratch picker (Grade / Section / Subject),
  // keeping a still-valid previous choice; lock it when there is nothing to offer.
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

  // ── snapshot helpers (rebuilt lists restore from these copies) ──────────────
  function snapshotStudentOptions(selectEl) {
    return Array.prototype.slice
      .call(selectEl.querySelectorAll('option'))
      .filter(function (o) { return o.value !== ''; })
      .map(function (o) {
        return {
          value: o.value,
          label: o.textContent.trim(),
          grade: o.getAttribute('data-grade') || GRADE_NONE,
          section: o.getAttribute('data-section') || SECTION_NONE,
          cls: o.getAttribute('data-class') || '',
        };
      });
  }

  function snapshotTestOptions(selectEl) {
    return Array.prototype.slice
      .call(selectEl.querySelectorAll('option'))
      .filter(function (o) { return o.value !== ''; })
      .map(function (o) {
        var classes = [];
        try { classes = JSON.parse(o.getAttribute('data-classes') || '[]'); } catch (e) { classes = []; }
        return {
          value: o.value,
          label: o.textContent.trim(),
          session: o.getAttribute('data-session') || '',
          subject: o.getAttribute('data-subject') || '',
          classes: classes.map(String),
        };
      });
  }

  function snapshotSubjectOptions(selectEl) {
    return Array.prototype.slice
      .call(selectEl.querySelectorAll('option'))
      .filter(function (o) { return o.value !== ''; })
      .map(function (o) { return { value: o.value, label: o.textContent.trim() }; });
  }

  // Grade/section behind a test's targeted classes. A class id missing from the
  // scope map counts as grade/section 'none' so it can still match a 'none' pick.
  function testGradeSections(t) {
    var pairs = [];
    var seen = {};
    t.classes.forEach(function (c) {
      var cs = CLASS_SCOPE[c];
      var key = ((cs && cs.grade) || GRADE_NONE) + '|' + ((cs && cs.section) || SECTION_NONE);
      if (seen[key]) return;
      seen[key] = true;
      pairs.push({ grade: (cs && cs.grade) || GRADE_NONE, section: (cs && cs.section) || SECTION_NONE });
    });
    return pairs;
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

    var studentPlaceholder = studentSelect.querySelector('option[value=""]');
    var testPlaceholder = testSelect.querySelector('option[value=""]');

    // Per-panel snapshots — rebuilt lists restore from these copies. Each panel
    // renders the same server data, but keeping them scoped to the panel avoids
    // any cross-panel coupling.
    var STU = snapshotStudentOptions(studentSelect);   // { value, label, grade, section, cls }
    var TESTS = snapshotTestOptions(testSelect);       // { value, label, session, subject, classes[] }
    var SUBJ = snapshotSubjectOptions(subjectSelect);  // { value, label }
    var TOTAL_TESTS = TESTS.length;

    // ClassLevels covered by at least one test of the chosen session.
    // Empty string / null sessionId → null meaning "no session narrowing".
    function coveredClassIds(sessionId) {
      if (!sessionId) return null;
      var set = {};
      TESTS.forEach(function (t) {
        if (t.session === sessionId) t.classes.forEach(function (c) { set[c] = true; });
      });
      return set;
    }

    // Students inside the current Session (+Grade +Section) scope. This pool is
    // the single source the Grade/Section/Student dropdowns are built from, so
    // every level shows only real, valid options for what is picked above it.
    function sessionPool() {
      var covered = coveredClassIds(sessionSelect.value);
      if (!covered) return STU;
      // A pupil with no class link (shouldn't exist — classLevel is required)
      // can never be covered by a session's tests, so it drops out.
      return STU.filter(function (s) { return s.cls && covered[s.cls]; });
    }

    function studentPool() {
      var g = gradeSelect.value;
      var sec = sectionSelect.value;
      return sessionPool().filter(function (s) {
        if (g && s.grade !== g) return false;
        if (sec && s.section !== sec) return false;
        return true;
      });
    }

    // Tests matching the current Session + Grade + Section scope (subject not
    // applied yet — this feeds the Subject picker's own narrowing).
    function testsInPupilScope() {
      var sessionId = sessionSelect.value;
      var g = gradeSelect.value;
      var sec = sectionSelect.value;
      return TESTS.filter(function (t) {
        if (sessionId && t.session !== sessionId) return false;
        if (g || sec) {
          var pairs = testGradeSections(t);
          var hit = pairs.some(function (p) {
            if (g && p.grade !== g) return false;
            if (sec && p.section !== sec) return false;
            return true;
          });
          if (!hit) return false;
        }
        return true;
      });
    }

    // ── pupil funnel: Session → Grade → Section → Student ────────────────────
    function rebuildGrades() {
      var pool = sessionPool();
      var items = distinct(pool, 'grade', function (g) { return g === GRADE_NONE ? 'No grade' : 'Grade ' + g; });
      items.sort(function (a, b) { return gradeSort(a.value, b.value); });
      var placeholder = sessionSelect.value
        ? (items.length ? 'All grades' : 'No grades in this session')
        : 'All grades';
      fillSelect(gradeSelect, placeholder, items);
      rebuildSections();
    }

    function rebuildSections() {
      var g = gradeSelect.value;
      var pool = sessionPool();
      if (g) pool = pool.filter(function (s) { return s.grade === g; });
      fillSelect(sectionSelect, 'All sections', distinct(pool, 'section', function (s) {
        return s === SECTION_NONE ? 'No section' : s;
      }));
      rebuildStudents();
    }

    function rebuildStudents() {
      refillWithOptions(studentSelect, studentPlaceholder, studentPool());
    }

    // ── test funnel: Session + Grade + Section → Subject → Test ───────────────
    function rebuildSubjects() {
      var inScope = testsInPupilScope();
      var scopeSet = {};
      inScope.forEach(function (t) { scopeSet[t.subject] = true; });
      // Keep the server-rendered (role-scoped) subjects, but drop any that have
      // no test in the current session/grade/section scope. Once anything below
      // Session tightens the test scope, an irrelevant subject is stale.
      var narrowed = (sessionSelect.value || gradeSelect.value || sectionSelect.value)
        ? SUBJ.filter(function (s) { return scopeSet[s.value]; })
        : SUBJ;
      fillSelect(subjectSelect, 'All subjects', narrowed);
    }

    function rebuildTests() {
      var subjectId = subjectSelect.value;
      var shown = testsInPupilScope().filter(function (t) {
        return !subjectId || t.subject === subjectId;
      });
      refillWithOptions(testSelect, testPlaceholder, shown);
      if (countLine) {
        var filtered = sessionSelect.value || gradeSelect.value || sectionSelect.value || subjectSelect.value;
        countLine.textContent = filtered
          ? 'Showing ' + shown.length + ' of ' + TOTAL_TESTS + ' tests.'
          : TOTAL_TESTS + ' tests grouped by session and subject.';
      }
    }

    // Full chain rebuild — changing any upstream field re-narrows everything
    // below it (stale options from the previous selection never survive).
    function rebuildFromSession() { rebuildGrades(); rebuildSubjects(); rebuildTests(); }
    function rebuildFromGrade() { rebuildSections(); rebuildSubjects(); rebuildTests(); }
    function rebuildFromSection() { rebuildStudents(); rebuildSubjects(); rebuildTests(); }

    // ── listeners ─────────────────────────────────────────────────────────────
    sessionSelect.addEventListener('change', rebuildFromSession);
    gradeSelect.addEventListener('change', rebuildFromGrade);
    sectionSelect.addEventListener('change', rebuildFromSection);
    subjectSelect.addEventListener('change', rebuildTests);

    // ── init ──────────────────────────────────────────────────────────────────
    rebuildFromSession();
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
