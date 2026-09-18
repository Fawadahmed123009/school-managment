(function() {
  const classCheckboxes = document.querySelectorAll('.class-cb');
  const selectAllBtn = document.getElementById('select-all-classes');
  const clearAllBtn = document.getElementById('clear-all-classes');
  const classCount = document.getElementById('class-count');
  const subjectSelect = document.getElementById('subject-select');
  const markAction = document.getElementById('mark-action');
  const markBtn = document.getElementById('mark-btn');
  const testInfo = document.getElementById('test-info');

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

  function resetDownstream() {
    setOptions(subjectSelect, [{ value: '', label: 'Select class(es) first...' }]);
    subjectSelect.disabled = true;
    if (window.__cascadeFilters) window.__cascadeFilters.resetAll();
    markAction.style.display = 'none';
  }

  // ── Fetch auth headers ──────────────────────────────────────────────────
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
      updateClassCount();
      loadSubjects();
    });
  }
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', function() {
      classCheckboxes.forEach(function(cb) { cb.checked = false; });
      updateClassCount();
      resetDownstream();
    });
  }

  // ── Level 1 → Level 2: Load subjects for selected classes ──────────────
  async function loadSubjects() {
    var classIds = getSelectedClassIds();
    updateClassCount();
    // Reset the shared cascade filters (session/phase/week/test)
    if (window.__cascadeFilters) window.__cascadeFilters.resetAll();
    markAction.style.display = 'none';

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
          // Show class annotation when multiple classes selected
          if (s.classLevels && classIds.length > 1) {
            var classNames = [];
            s.classLevels.forEach(function(cid) {
              var cb = document.querySelector('.class-cb[value="' + cid + '"]');
              if (cb) {
                var lbl = cb.parentElement.textContent.trim();
                classNames.push(lbl);
              }
            });
            opt.textContent = s.name + ' (' + classNames.join(', ') + ')';
          } else {
            opt.textContent = s.name;
          }
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
      loadSubjects();
    });
  });

  // ── React to test selection from shared cascade filters ────────────────
  document.addEventListener('cascade:test-changed', function(e) {
    var testId = e.detail.testId;
    if (testId) {
      markBtn.href = '/tests/mark/' + testId;
      // Find the label from the test select dropdown
      var testSelect = document.getElementById('test-select');
      testInfo.textContent = testSelect.options[testSelect.selectedIndex].textContent;
      markAction.style.display = 'flex';
      markAction.style.alignItems = 'center';
    } else {
      markAction.style.display = 'none';
    }
  });
})();
