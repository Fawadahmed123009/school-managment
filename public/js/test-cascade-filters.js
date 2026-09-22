/**
 * Shared step-down cascade filter logic for Session → Phase → Week → Test.
 * Used by both test-cascade-pick.js (teacher mark-entry) and
 * test-cascade-ocr.js (OCR marks entry) to keep filtering consistent.
 *
 * Expects these DOM elements to exist:
 *   .class-cb              – class checkboxes (managed by the page script)
 *   #subject-select         – subject dropdown (managed by the page script)
 *   #session-field          – wrapper for session dropdown (shown/hidden here)
 *   #session-select         – session dropdown
 *   #phase-field            – wrapper for phase dropdown (shown/hidden here)
 *   #phase-select           – phase dropdown
 *   #week-field             – wrapper for week dropdown (shown/hidden here)
 *   #week-select            – week dropdown
 *   #test-field             – wrapper for test dropdown (shown/hidden here)
 *   #test-select            – test dropdown
 *
 * The page-specific script must call window.__cascadeFilters.getSelectedTestId()
 * to retrieve the currently selected test ID.
 */
(function() {
  var subjectSelect  = document.getElementById('subject-select');
  var sessionField   = document.getElementById('session-field');
  var sessionSelect  = document.getElementById('session-select');
  var phaseField     = document.getElementById('phase-field');
  var phaseSelect    = document.getElementById('phase-select');
  var weekField      = document.getElementById('week-field');
  var weekSelect     = document.getElementById('week-select');
  var testField      = document.getElementById('test-field');
  var testSelect     = document.getElementById('test-select');

  if (!subjectSelect || !sessionSelect) return; // not on a cascade page

  // ── Helpers ──────────────────────────────────────────────────────────────
  function getSelectedClassIds() {
    var ids = [];
    document.querySelectorAll('.class-cb').forEach(function(cb) {
      if (cb.checked) ids.push(cb.value);
    });
    return ids;
  }

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

  function hideField(fieldEl, selectEl, placeholder) {
    if (fieldEl) fieldEl.style.display = 'none';
    if (selectEl) {
      setOptions(selectEl, [{ value: '', label: placeholder }]);
      selectEl.disabled = true;
    }
  }

  function showField(fieldEl, selectEl) {
    if (fieldEl) fieldEl.style.display = '';
    if (selectEl) selectEl.disabled = false;
  }

  /** Reset everything downstream of subject (session, phase, week, test). */
  function resetFromSession() {
    hideField(sessionField, sessionSelect, 'Select a subject first...');
    hideField(phaseField, phaseSelect, 'Select a session first...');
    hideField(weekField, weekSelect, 'Select a phase first...');
    hideField(testField, testSelect, 'Select filters first...');
    notifyTestChanged(null);
  }

  function resetFromPhase() {
    hideField(weekField, weekSelect, 'Select a phase first...');
    hideField(testField, testSelect, 'Select filters first...');
    notifyTestChanged(null);
  }

  function resetFromWeek() {
    hideField(testField, testSelect, 'Select filters first...');
    notifyTestChanged(null);
  }

  /** Dispatch a custom event so page-specific scripts can react. */
  function notifyTestChanged(testId) {
    document.dispatchEvent(new CustomEvent('cascade:test-changed', { detail: { testId: testId } }));
  }

  // ── Subject changed → load sessions ──────────────────────────────────────
  subjectSelect.addEventListener('change', async function() {
    var subjectId = this.value;
    var classIds = getSelectedClassIds();

    resetFromSession();

    if (!subjectId || classIds.length === 0) return;

    setOptions(sessionSelect, [{ value: '', label: 'Loading...' }]);
    sessionSelect.disabled = true;
    sessionField.style.display = '';

    try {
      var res = await fetch(
        '/api/v1/tests/cascade/sessions?classLevel=' + classIds.join(',') + '&subject=' + subjectId,
        { headers: getHeaders() }
      );
      var data = await res.json();

      if (data.status === 'success') {
        var opts = [{ value: '', label: 'Choose a session...' }];
        var sess = data.data.sessions || [];
        sess.forEach(function(s) {
          opts.push({ value: s._id, label: s.name });
        });
        if (data.data.hasUnassigned) {
          opts.push({ value: 'none', label: 'No session' });
        }
        setOptions(sessionSelect, opts);
        if (sess.length > 0 || data.data.hasUnassigned) {
          showField(sessionField, sessionSelect);
        } else {
          hideField(sessionField, sessionSelect, 'No sessions available');
          loadTests();
        }
      } else {
        hideField(sessionField, sessionSelect, 'Error loading sessions');
        console.error('Failed to load sessions:', data.message);
      }
    } catch (err) {
      hideField(sessionField, sessionSelect, 'Error loading sessions');
      console.error('Failed to load sessions:', err);
    }
  });

  // ── Session changed → load phases ────────────────────────────────────────
  sessionSelect.addEventListener('change', async function() {
    var sessionId = this.value;
    var subjectId = subjectSelect.value;
    var classIds = getSelectedClassIds();

    resetFromPhase();

    if (!sessionId || !subjectId) return;

    // "No session" selected — load tests with session=null directly
    if (sessionId === 'none') {
      loadTests();
      return;
    }

    setOptions(phaseSelect, [{ value: '', label: 'Loading...' }]);
    phaseSelect.disabled = true;
    phaseField.style.display = '';

    try {
      var res = await fetch(
        '/api/v1/tests/cascade/phases?classLevel=' + classIds.join(',') +
        '&subject=' + subjectId + '&session=' + sessionId,
        { headers: getHeaders() }
      );
      var data = await res.json();

      if (data.status === 'success') {
        var opts = [{ value: '', label: 'Choose a phase...' }];
        var phases = data.data.phases || [];
        phases.forEach(function(p) {
          opts.push({ value: p._id, label: p.name });
        });
        if (data.data.hasUnassigned) {
          opts.push({ value: 'none', label: 'No phase' });
        }
        setOptions(phaseSelect, opts);
        if (phases.length > 0 || data.data.hasUnassigned) {
          showField(phaseField, phaseSelect);
        } else {
          hideField(phaseField, phaseSelect, 'No phases available');
          loadTests();
        }
      } else {
        hideField(phaseField, phaseSelect, 'Error loading phases');
        console.error('Failed to load phases:', data.message);
      }
    } catch (err) {
      hideField(phaseField, phaseSelect, 'Error loading phases');
      console.error('Failed to load phases:', err);
    }
  });

  // ── Phase changed → load weeks ───────────────────────────────────────────
  phaseSelect.addEventListener('change', async function() {
    var phaseId = this.value;
    var sessionId = sessionSelect.value;
    var subjectId = subjectSelect.value;
    var classIds = getSelectedClassIds();

    resetFromWeek();

    if (!phaseId || !sessionId) return;

    // "No phase" selected — load tests with phase=null directly
    if (phaseId === 'none') {
      loadTests();
      return;
    }

    setOptions(weekSelect, [{ value: '', label: 'Loading...' }]);
    weekSelect.disabled = true;
    weekField.style.display = '';

    try {
      var res = await fetch(
        '/api/v1/tests/cascade/weeks?classLevel=' + classIds.join(',') +
        '&subject=' + subjectId + '&session=' + sessionId + '&phase=' + phaseId,
        { headers: getHeaders() }
      );
      var data = await res.json();

      if (data.status === 'success') {
        var opts = [{ value: '', label: 'Choose a week...' }];
        var weeks = data.data.weeks || [];
        weeks.forEach(function(w) {
          var start = new Date(w.startDate).toLocaleDateString();
          var end = new Date(w.endDate).toLocaleDateString();
          opts.push({ value: w._id, label: w.name + ' (' + start + ' \u2013 ' + end + ')' });
        });
        if (data.data.hasUnassigned) {
          opts.push({ value: 'none', label: 'No week' });
        }
        setOptions(weekSelect, opts);
        if (weeks.length > 0 || data.data.hasUnassigned) {
          showField(weekField, weekSelect);
        } else {
          hideField(weekField, weekSelect, 'No weeks available');
          loadTests();
        }
      } else {
        hideField(weekField, weekSelect, 'Error loading weeks');
        console.error('Failed to load weeks:', data.message);
      }
    } catch (err) {
      hideField(weekField, weekSelect, 'Error loading weeks');
      console.error('Failed to load weeks:', err);
    }
  });

  // ── Week changed → load tests ────────────────────────────────────────────
  weekSelect.addEventListener('change', function() {
    loadTests();
  });

  // ── Load tests with current filter state ─────────────────────────────────
  async function loadTests() {
    var subjectId = subjectSelect.value;
    var classIds = getSelectedClassIds();
    if (!subjectId || classIds.length === 0) return;

    var sessionId = sessionSelect.value || '';
    var phaseId = phaseSelect.value || '';
    var weekId = weekSelect.value || '';

    setOptions(testSelect, [{ value: '', label: 'Loading...' }]);
    testSelect.disabled = true;
    testField.style.display = '';

    var url = '/api/v1/tests/cascade/tests?classLevel=' + classIds.join(',') + '&subject=' + subjectId;
    if (sessionId) url += '&session=' + sessionId;
    if (phaseId) url += '&phase=' + phaseId;
    if (weekId) url += '&week=' + weekId;

    try {
      var res = await fetch(url, { headers: getHeaders() });
      var data = await res.json();

      if (data.status === 'success' && data.data.length > 0) {
        var opts = [{ value: '', label: 'Choose a test...' }];
        data.data.forEach(function(t) {
          var date = new Date(t.date).toLocaleDateString();
          // Test name and date only — session/class annotations clutter the list.
          opts.push({ value: t._id, label: t.name + ' (' + date + ')' });
        });
        setOptions(testSelect, opts);
        testSelect.disabled = false;
      } else if (data.status === 'success') {
        setOptions(testSelect, [{ value: '', label: 'No tests match these filters' }]);
      } else {
        setOptions(testSelect, [{ value: '', label: 'Error loading tests' }]);
        console.error('Failed to load tests:', data.message);
      }
    } catch (err) {
      setOptions(testSelect, [{ value: '', label: 'Error loading tests' }]);
      console.error('Failed to load tests:', err);
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
    /** Called by the page script when class checkboxes change to reset everything. */
    resetAll: resetFromSession,
  };
})();
