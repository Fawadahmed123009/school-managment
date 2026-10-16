/**
 * Shared seven-level step-down cascade filter for marking tests:
 *   Session → Grade → Section → Phase → Week → Subject → Test
 * Used by both test-cascade-pick.js (manual mark-entry) and
 * test-cascade-ocr.js (OCR mark-entry) so the two pages never drift.
 *
 * Every dropdown is populated ONLY from the server, which derives each level
 * from the teacher's own Assignment records — the client never needs to know
 * its classes or subjects up front.
 *
 * Expects these DOM elements to exist (see views/partials/mark-test-cascade.ejs):
 *   #session-field  #session-select
 *   #grade-field    #grade-select
 *   #section-field  #section-select
 *   #phase-field    #phase-select
 *   #week-field     #week-select
 *   #subject-field  #subject-select
 *   #test-field     #test-select
 *
 * The page-specific script reacts to the 'cascade:test-changed' event
 * (detail.testId) and can call window.__cascadeFilters.getSelectedTestId().
 */
(function() {
  var sessionField   = document.getElementById('session-field');
  var sessionSelect  = document.getElementById('session-select');
  var gradeField     = document.getElementById('grade-field');
  var gradeSelect    = document.getElementById('grade-select');
  var sectionField   = document.getElementById('section-field');
  var sectionSelect  = document.getElementById('section-select');
  var phaseField     = document.getElementById('phase-field');
  var phaseSelect    = document.getElementById('phase-select');
  var weekField      = document.getElementById('week-field');
  var weekSelect     = document.getElementById('week-select');
  var subjectField   = document.getElementById('subject-field');
  var subjectSelect  = document.getElementById('subject-select');
  var testField      = document.getElementById('test-field');
  var testSelect     = document.getElementById('test-select');

  if (!sessionSelect || !gradeSelect || !sectionSelect) return; // not on a cascade page

  // ── Helpers ──────────────────────────────────────────────────────────────
  function getHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var meta = document.querySelector('meta[name="auth-token"]');
    if (meta && meta.content) headers['Authorization'] = 'Bearer ' + meta.content;
    return headers;
  }

  /** Replace all options in a <select> using safe DOM construction. */
  function setOptions(selectEl, items) {
    while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
    items.forEach(function(item) {
      var opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      selectEl.appendChild(opt);
    });
  }

  function fillField(fieldEl, selectEl, items, placeholder) {
    var opts = [{ value: '', label: placeholder }].concat(items);
    setOptions(selectEl, opts);
    if (fieldEl) fieldEl.style.display = '';
    // Lockable only when there is nothing to choose (placeholder alone).
    selectEl.disabled = opts.length === 1;
  }

  /** Park a level on a fixed placeholder: hidden downstream reset state. */
  function resetField(fieldEl, selectEl, placeholder) {
    if (fieldEl) fieldEl.style.display = '';
    setOptions(selectEl, [{ value: '', label: placeholder }]);
    selectEl.disabled = true;
  }

  /**
   * Not-yet-applicable level (e.g. Phase/Week when the session is "none").
   * Shown but visibly disabled with a message, so the row never disappears
   * mid-cascade and the numbering stays stable.
   */
  function skipField(fieldEl, selectEl, message) {
    if (fieldEl) fieldEl.style.display = '';
    setOptions(selectEl, [{ value: '', label: message }]);
    selectEl.disabled = true;
  }

  /** Dispatch a custom event so page-specific scripts can react. */
  function notifyTestChanged(testId) {
    document.dispatchEvent(new CustomEvent('cascade:test-changed', { detail: { testId: testId } }));
  }

  // Reset chains — each level clears everything below it.
  function resetFromGrade()    { resetField(gradeField, gradeSelect, 'Select a session first...'); resetFromSection(); }
  function resetFromSection()  { allSectionIds = []; resetField(sectionField, sectionSelect, 'Select a grade first...'); resetFromPhase(); }
  function resetFromPhase()    { resetField(phaseField, phaseSelect, 'Select a section first...'); resetFromWeek(); }
  function resetFromWeek()     { resetField(weekField, weekSelect, 'Select a phase first...'); resetFromSubject(); }
  function resetFromSubject()  { resetField(subjectField, subjectSelect, 'Select a week first...'); resetFromTest(); }
  function resetFromTest()     { resetField(testField, testSelect, 'Select filters first...'); notifyTestChanged(null); }

  /** GET a cascade endpoint, returning parsed JSON or null on any failure. */
  async function getCascade(url) {
    try {
      var res = await fetch(url, { headers: getHeaders() });
      return await res.json();
    } catch (err) {
      console.error('Cascade request failed:', url, err);
      return null;
    }
  }

  // ── Level 1: Session — no upstream selection needed ──────────────────────
  function selectedSession() { return sessionSelect.value; }
  // "All sections" is a client-side alias for the full list of section ids the
  // server just offered — downstream endpoints receive the comma-separated ids
  // and scope every read to the union of the teacher's own pairs behind them.
  var allSectionIds = [];
  function selectedSection() {
    return sectionSelect.value === 'all' ? allSectionIds.join(',') : sectionSelect.value;
  }

  async function loadSessions() {
    fillField(sessionField, sessionSelect, [], 'Loading…');
    var data = await getCascade('/api/v1/tests/cascade/sessions');
    if (!data || data.status !== 'success') {
      resetField(sessionField, sessionSelect, 'Error loading sessions');
      return;
    }
    var items = (data.data.sessions || []).map(function(s) { return { value: s._id, label: s.name }; });
    if (data.data.hasUnassigned) items.push({ value: 'none', label: 'No session' });
    if (items.length === 0) {
      resetField(sessionField, sessionSelect, 'No tests are assigned to you yet');
      return;
    }
    fillField(sessionField, sessionSelect, items, 'Choose a session...');
  }

  // ── Level 2: Grade — narrowed by the chosen session ──────────────────────
  sessionSelect.addEventListener('change', async function() {
    resetFromGrade();
    var sessionId = selectedSession();
    if (!sessionId) return;

    fillField(gradeField, gradeSelect, [], 'Loading…');
    var data = await getCascade('/api/v1/tests/cascade/grades?session=' + encodeURIComponent(sessionId));
    if (!data || data.status !== 'success') {
      resetField(gradeField, gradeSelect, 'Error loading grades');
      return;
    }
    var items = (data.data.grades || []).map(function(g) {
      return { value: g, label: g === 'PG' ? 'PG (Preparatory)' : 'Grade ' + g };
    });
    if (items.length === 0) {
      resetField(gradeField, gradeSelect, 'No grades match this session');
      return;
    }
    fillField(gradeField, gradeSelect, items, 'Choose a grade...');
    // A single grade saves a click — drive the change handler directly.
    if (items.length === 1) {
      gradeSelect.value = items[0].value;
      gradeSelect.dispatchEvent(new Event('change'));
    }
  });

  // ── Level 3: Section — assigned sections of the chosen grade ─────────────
  gradeSelect.addEventListener('change', async function() {
    resetFromSection();
    var sessionId = selectedSession();
    var grade = gradeSelect.value;
    if (!sessionId || !grade) return;

    fillField(sectionField, sectionSelect, [], 'Loading…');
    var data = await getCascade(
      '/api/v1/tests/cascade/sections?session=' + encodeURIComponent(sessionId) +
      '&grade=' + encodeURIComponent(grade)
    );
    if (!data || data.status !== 'success') {
      resetField(sectionField, sectionSelect, 'Error loading sections');
      return;
    }
    var items = (data.data.sections || []).map(function(s) {
      var label = (s.gradeLevel ? s.gradeLevel + ' — ' : '') + s.name + (s.group ? ' (' + s.group + ')' : '');
      return { value: s._id, label: label };
    });
    if (items.length === 0) {
      resetField(sectionField, sectionSelect, 'No sections match — you may not be assigned here');
      return;
    }
    // More than one section in this grade → offer an "All sections" shortcut.
    if (items.length > 1) {
      allSectionIds = items.map(function(i) { return i.value; });
      items.unshift({ value: 'all', label: 'All sections (' + items.length + ')' });
    }
    fillField(sectionField, sectionSelect, items, 'Choose a section...');
    // One section in this grade → auto-select, saving a click. Dispatching the
    // real change event keeps every downstream side-effect on one code path.
    if (items.length === 1) {
      sectionSelect.value = items[0].value;
      sectionSelect.dispatchEvent(new Event('change'));
    }
  });

  // ── Level 4/5: Phase → Week — skipped when the session bucket is "none" ──
  sectionSelect.addEventListener('change', function() {
    resetFromPhase();
    var sessionId = selectedSession();
    var sectionId = selectedSection();
    if (!sessionId || !sectionId) return;

    // Tests without a session have no phases/weeks — jump to Subject.
    if (sessionId === 'none') {
      skipField(phaseField, phaseSelect, 'Not applicable (no session)');
      skipField(weekField, weekSelect, 'Not applicable (no session)');
      loadSubjects();
      return;
    }

    loadPhases();
  });

  async function loadPhases() {
    fillField(phaseField, phaseSelect, [], 'Loading…');
    var data = await getCascade(
      '/api/v1/tests/cascade/phases?session=' + encodeURIComponent(selectedSession()) +
      '&section=' + encodeURIComponent(selectedSection())
    );
    if (!data || data.status !== 'success') {
      resetField(phaseField, phaseSelect, 'Error loading phases');
      return;
    }
    var items = (data.data.phases || []).map(function(p) { return { value: p._id, label: p.name }; });
    if (data.data.hasUnassigned) items.push({ value: 'none', label: 'No phase' });
    if (items.length === 0) {
      // Defensive: every test sits in a phase bucket, so this only happens on
      // odd data — skip the levels and let Subject narrow further.
      skipField(phaseField, phaseSelect, 'No phases available');
      skipField(weekField, weekSelect, 'No phases available');
      loadSubjects();
      return;
    }
    fillField(phaseField, phaseSelect, items, 'Choose a phase...');
  }

  phaseSelect.addEventListener('change', function() {
    resetFromWeek();
    var phaseId = phaseSelect.value;
    if (!phaseId) return;

    // "No phase" bucket has no weeks — jump to Subject with phase=none.
    if (phaseId === 'none') {
      skipField(weekField, weekSelect, 'Not applicable (no phase)');
      loadSubjects();
      return;
    }

    loadWeeks();
  });

  async function loadWeeks() {
    fillField(weekField, weekSelect, [], 'Loading…');
    var data = await getCascade(
      '/api/v1/tests/cascade/weeks?session=' + encodeURIComponent(selectedSession()) +
      '&section=' + encodeURIComponent(selectedSection()) +
      '&phase=' + encodeURIComponent(phaseSelect.value)
    );
    if (!data || data.status !== 'success') {
      resetField(weekField, weekSelect, 'Error loading weeks');
      return;
    }
    var items = (data.data.weeks || []).map(function(w) {
      var start = new Date(w.startDate).toLocaleDateString();
      var end = new Date(w.endDate).toLocaleDateString();
      return { value: w._id, label: w.name + ' (' + start + ' \u2013 ' + end + ')' };
    });
    if (data.data.hasUnassigned) items.push({ value: 'none', label: 'No week' });
    if (items.length === 0) {
      resetField(weekField, weekSelect, 'No weeks available');
      return;
    }
    fillField(weekField, weekSelect, items, 'Choose a week...');
  }

  // ── Level 6: Subject — narrowed by the WHOLE upstream chain ──────────────
  // Because phase/week are part of the query, a subject only appears when a
  // markable test actually exists behind the full selection — no dead ends.
  weekSelect.addEventListener('change', function() {
    resetFromSubject();
    if (!weekSelect.value) return;
    loadSubjects();
  });

  function upstreamParams() {
    var url = 'session=' + encodeURIComponent(selectedSession()) +
              '&section=' + encodeURIComponent(selectedSection());
    var phaseId = phaseSelect.value;
    var weekId = weekSelect.value;
    if (phaseId) url += '&phase=' + encodeURIComponent(phaseId);
    if (weekId) url += '&week=' + encodeURIComponent(weekId);
    return url;
  }

  async function loadSubjects() {
    var sessionId = selectedSession();
    var sectionId = selectedSection();
    if (!sessionId || !sectionId) return;

    fillField(subjectField, subjectSelect, [], 'Loading…');
    var data = await getCascade('/api/v1/tests/cascade/subjects?' + upstreamParams());
    if (!data || data.status !== 'success') {
      resetField(subjectField, subjectSelect, 'Error loading subjects');
      return;
    }
    var items = (data.data || []).map(function(s) {
      return { value: s._id, label: s.displayName || s.name };
    });
    if (items.length === 0) {
      resetField(subjectField, subjectSelect, 'No subjects match these filters');
      return;
    }
    fillField(subjectField, subjectSelect, items, 'Choose a subject...');
    // Single subject (e.g. one teacher of one section) → jump straight to tests.
    if (items.length === 1) {
      subjectSelect.value = items[0].value;
      subjectSelect.dispatchEvent(new Event('change'));
    }
  }

  // ── Level 7: Test ─────────────────────────────────────────────────────────
  subjectSelect.addEventListener('change', function() {
    resetFromTest();
    if (!subjectSelect.value) return;
    loadTests();
  });

  async function loadTests() {
    var subjectId = subjectSelect.value;
    var sectionId = selectedSection();
    if (!subjectId || !sectionId) return;

    fillField(testField, testSelect, [], 'Loading…');
    // The tests endpoint keeps its historical classLevel param name.
    var url = '/api/v1/tests/cascade/tests?classLevel=' + encodeURIComponent(sectionId) +
              '&subject=' + encodeURIComponent(subjectId);
    var sessionId = selectedSession();
    var phaseId = phaseSelect.value;
    var weekId = weekSelect.value;
    if (sessionId) url += '&session=' + encodeURIComponent(sessionId);
    if (phaseId) url += '&phase=' + encodeURIComponent(phaseId);
    if (weekId) url += '&week=' + encodeURIComponent(weekId);

    var data = await getCascade(url);
    if (data && data.status === 'success' && data.data.length > 0) {
      var items = data.data.map(function(t) {
        var date = new Date(t.date).toLocaleDateString();
        // Test name and date only — session/class annotations clutter the list.
        return { value: t._id, label: t.name + ' (' + date + ')' };
      });
      fillField(testField, testSelect, items, 'Choose a test...');
    } else if (data && data.status === 'success') {
      resetField(testField, testSelect, 'No tests match these filters');
    } else {
      resetField(testField, testSelect, 'Error loading tests');
      console.error('Failed to load tests:', data && data.message);
    }
  }

  // ── Test selected → notify page-specific script ──────────────────────────
  testSelect.addEventListener('change', function() {
    notifyTestChanged(this.value || null);
  });

  // ── Public API for page-specific scripts ─────────────────────────────────
  window.__cascadeFilters = {
    getSelectedTestId: function() {
      return testSelect.value || null;
    },
    /** Full reset back to level 1 (keeps the session list, clears the rest). */
    resetAll: resetFromGrade,
  };

  // ── Kick off: sessions are teacher-derived and need no upstream choice ───
  loadSessions();
})();
