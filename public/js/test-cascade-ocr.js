(function() {
  const classCheckboxes = document.querySelectorAll('.class-cb');
  const selectAllBtn = document.getElementById('select-all-classes');
  const clearAllBtn = document.getElementById('clear-all-classes');
  const classCount = document.getElementById('class-count');
  const subjectSelect = document.getElementById('subject-select');
  const uploadDrop = document.getElementById('upload-drop');
  const cameraDrop = document.getElementById('camera-drop');
  const testSettings = document.getElementById('test-settings');
  const totalMarksInput = document.getElementById('ocr-total-marks');
  const passMarksInput = document.getElementById('ocr-pass-marks');
  const saveMarksBtn = document.getElementById('ocr-save-marks');
  const marksStatus = document.getElementById('ocr-marks-status');

  // Show/hide both the file-picker drop and the camera-capture panel together
  function setShowPhotoAreas(visible) {
    if (uploadDrop) uploadDrop.style.display = visible ? 'block' : 'none';
    if (cameraDrop) cameraDrop.style.display = visible ? 'block' : 'none';
  }

  if (!classCheckboxes.length) return;

  // ── Helpers ──────────────────────────────────────────────────────────────
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

  function getSelectedClassIds() {
    var ids = [];
    classCheckboxes.forEach(function(cb) { if (cb.checked) ids.push(cb.value); });
    return ids;
  }

  function updateClassCount() {
    var n = getSelectedClassIds().length;
    if (classCount) classCount.textContent = n > 0 ? n + ' selected' : '';
  }

  /** Reflect selection state on each grade's "all sections" checkbox. */
  function syncGradeCheckBoxes() {
    document.querySelectorAll('.grade-group').forEach(function (group) {
      var gradeCb = group.querySelector('.grade-all-cb');
      if (!gradeCb) return;
      var boxes = group.querySelectorAll('.class-cb');
      var checked = 0;
      boxes.forEach(function (cb) { if (cb.checked) checked++; });
      gradeCb.checked = checked === boxes.length;
      gradeCb.indeterminate = checked > 0 && checked < boxes.length;
    });
  }

  function resetDownstream() {
    setOptions(subjectSelect, [{ value: '', label: 'Select class(es) first...' }]);
    subjectSelect.disabled = true;
    if (window.__cascadeFilters) window.__cascadeFilters.resetAll();
    setShowPhotoAreas(false);
  }

  function getHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var meta = document.querySelector('meta[name="auth-token"]');
    if (meta && meta.content) headers['Authorization'] = 'Bearer ' + meta.content;
    return headers;
  }

  // ── Select all / Clear ──────────────────────────────────────────────────
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', function() {
      classCheckboxes.forEach(function(cb) { cb.checked = true; });
      syncGradeCheckBoxes();
      updateClassCount();
      loadSubjects();
    });
  }
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', function() {
      classCheckboxes.forEach(function(cb) { cb.checked = false; });
      syncGradeCheckBoxes();
      updateClassCount();
      resetDownstream();
    });
  }

  // ── Per-grade "select all sections" (e.g. all sections of Grade 9) ───────
  document.querySelectorAll('.grade-all-cb').forEach(function(gradeCb) {
    gradeCb.addEventListener('change', function() {
      var group = this.closest('.grade-group');
      if (!group) return;
      var checked = this.checked;
      group.querySelectorAll('.class-cb').forEach(function(cb) { cb.checked = checked; });
      this.indeterminate = false;
      loadSubjects();
    });
  });

  // ── Level 1 → Level 2: Load subjects for selected classes ──────────────
  async function loadSubjects() {
    var classIds = getSelectedClassIds();
    updateClassCount();
    // Reset the shared cascade filters (session/phase/week/test)
    if (window.__cascadeFilters) window.__cascadeFilters.resetAll();
    setShowPhotoAreas(false);

    if (classIds.length === 0) {
      setOptions(subjectSelect, [{ value: '', label: 'Select class(es) first...' }]);
      subjectSelect.disabled = true;
      return;
    }

    setOptions(subjectSelect, [{ value: '', label: 'Loading...' }]);
    subjectSelect.disabled = true;

    try {
      var res = await fetch('/api/v1/tests/cascade/subjects?classLevel=' + classIds.join(','), {
        headers: getHeaders()
      });
      var data = await res.json();

      if (data.status === 'success' && data.data.length > 0) {
        setOptions(subjectSelect, [{ value: '', label: 'Choose a subject...' }]);
        data.data.forEach(function(s) {
          var opt = document.createElement('option');
          opt.value = s._id;
          // Subject name only — annotating sections clutters the dropdown.
          opt.textContent = s.name;
          subjectSelect.appendChild(opt);
        });
        subjectSelect.disabled = false;
      } else if (data.status === 'success') {
        setOptions(subjectSelect, [{ value: '', label: 'No subjects for selected classes' }]);
      } else {
        var msg = data.message || 'Error loading subjects';
        setOptions(subjectSelect, [{ value: '', label: msg }]);
        console.error('Failed to load subjects:', msg);
      }
    } catch (err) {
      setOptions(subjectSelect, [{ value: '', label: 'Error loading subjects' }]);
      console.error('Failed to load subjects:', err);
    }
  }

  // Listen for checkbox changes
  classCheckboxes.forEach(function(cb) {
    cb.addEventListener('change', function() {
      syncGradeCheckBoxes();
      loadSubjects();
    });
  });

  // ── Test score-scale editor (total / pass marks) ────────────────────
  // Populated lazily from the API once a test is chosen; saves via PATCH.
  function setMarksStatus(text, ok) {
    if (!marksStatus) return;
    marksStatus.textContent = text || '';
    marksStatus.style.color = ok ? 'var(--ok, green)' : 'var(--error, red)';
  }

  function showTestSettings(show) {
    if (testSettings) testSettings.style.display = show ? '' : 'none';
  }

  async function loadTestMarks(id) {
    if (!totalMarksInput) return;
    setMarksStatus('Loading…', true);
    try {
      var res = await fetch('/api/v1/tests/' + id + '/marks', { headers: getHeaders() });
      var data = await res.json();
      if (data.status === 'success') {
        totalMarksInput.value = data.data.totalMarks;
        passMarksInput.value = data.data.passMarks;
        setMarksStatus('', true);
      } else {
        setMarksStatus(data.message || 'Could not load marks', false);
      }
    } catch (err) {
      setMarksStatus('Could not load marks', false);
    }
  }

  if (saveMarksBtn) {
    saveMarksBtn.addEventListener('click', async function() {
      var id = window.selectedTestId;
      if (!id) return;
      saveMarksBtn.disabled = true;
      setMarksStatus('Saving…', true);
      try {
        var res = await fetch('/api/v1/tests/' + id + '/marks', {
          method: 'PATCH',
          headers: getHeaders(),
          body: JSON.stringify({ totalMarks: totalMarksInput.value, passMarks: passMarksInput.value }),
        });
        var data = await res.json();
        if (data.status === 'success') {
          setMarksStatus('Saved.', true);
        } else {
          setMarksStatus(data.message || 'Save failed', false);
        }
      } catch (err) {
        setMarksStatus('Save failed', false);
      } finally {
        saveMarksBtn.disabled = false;
      }
    });
  }

  // ── React to test selection from shared cascade filters ────────────────
  document.addEventListener('cascade:test-changed', function(e) {
    var testId = e.detail.testId;
    if (testId) {
      window.selectedTestId = testId;
      setShowPhotoAreas(true);
      showTestSettings(true);
      loadTestMarks(testId);
    } else {
      setShowPhotoAreas(false);
      showTestSettings(false);
    }
  });
})();
