(function() {
  const classCheckboxes = document.querySelectorAll('.class-cb');
  const selectAllBtn = document.getElementById('select-all-classes');
  const clearAllBtn = document.getElementById('clear-all-classes');
  const classCount = document.getElementById('class-count');
  const subjectSelect = document.getElementById('subject-select');
  const testSelect = document.getElementById('test-select');
  const markAction = document.getElementById('mark-action');
  const markBtn = document.getElementById('mark-btn');
  const testInfo = document.getElementById('test-info');

  if (!classCheckboxes.length) return;

  // ── Helpers ──────────────────────────────────────────────────────
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
    subjectSelect.innerHTML = '<option value="">Select class(es) first...</option>';
    subjectSelect.disabled = true;
    testSelect.innerHTML = '<option value="">Select a subject first...</option>';
    testSelect.disabled = true;
    markAction.style.display = 'none';
  }

  // ── Select all / Clear ──────────────────────────────────────────
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

  // ── Fetch auth headers ──────────────────────────────────────────
  function getHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var meta = document.querySelector('meta[name="auth-token"]');
    if (meta && meta.content) headers['Authorization'] = 'Bearer ' + meta.content;
    return headers;
  }

  // ── Level 1 → Level 2: Load subjects for selected classes ──────
  async function loadSubjects() {
    var classIds = getSelectedClassIds();
    updateClassCount();
    testSelect.innerHTML = '<option value="">Select a subject first...</option>';
    testSelect.disabled = true;
    markAction.style.display = 'none';

    if (classIds.length === 0) {
      subjectSelect.innerHTML = '<option value="">Select class(es) first...</option>';
      subjectSelect.disabled = true;
      return;
    }

    subjectSelect.innerHTML = '<option value="">Loading...</option>';
    subjectSelect.disabled = true;

    try {
      var res = await fetch('/api/v1/tests/cascade/subjects?classLevel=' + classIds.join(','), {
        headers: getHeaders()
      });
      var data = await res.json();

      if (data.status === 'success' && data.data.length > 0) {
        subjectSelect.innerHTML = '<option value="">Choose a subject...</option>';
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
        subjectSelect.innerHTML = '<option value="">No subjects for selected classes</option>';
      } else {
        var msg = data.message || 'Error loading subjects';
        subjectSelect.innerHTML = '<option value="">' + msg + '</option>';
        console.error('Failed to load subjects:', msg);
      }
    } catch (err) {
      subjectSelect.innerHTML = '<option value="">Error loading subjects</option>';
      console.error('Failed to load subjects:', err);
    }
  }

  // Listen for checkbox changes
  classCheckboxes.forEach(function(cb) {
    cb.addEventListener('change', function() {
      loadSubjects();
    });
  });

  // ── Level 2 → Level 3: Subject selected, load tests ────────────
  subjectSelect.addEventListener('change', async function() {
    var subjectId = this.value;
    var classIds = getSelectedClassIds();
    testSelect.innerHTML = '<option value="">Loading...</option>';
    testSelect.disabled = true;
    markAction.style.display = 'none';

    if (!subjectId) {
      testSelect.innerHTML = '<option value="">Select a subject first...</option>';
      return;
    }

    try {
      var res = await fetch('/api/v1/tests/cascade/tests?classLevel=' + classIds.join(',') + '&subject=' + subjectId, {
        headers: getHeaders()
      });
      var data = await res.json();

      if (data.status === 'success' && data.data.length > 0) {
        testSelect.innerHTML = '<option value="">Choose a test...</option>';
        data.data.forEach(function(t) {
          var opt = document.createElement('option');
          opt.value = t._id;
          var date = new Date(t.date).toLocaleDateString();
          var classLabel = '';
          if (t.classLevels && t.classLevels.length > 0) {
            classLabel = ' — ' + t.classLevels.map(function(cl) { return cl.name; }).join(', ');
          }
          opt.textContent = t.name + ' (' + date + ')' + classLabel;
          opt.dataset.testName = t.name;
          testSelect.appendChild(opt);
        });
        testSelect.disabled = false;
      } else if (data.status === 'success') {
        testSelect.innerHTML = '<option value="">No tests for this subject + classes</option>';
      } else {
        testSelect.innerHTML = '<option value="">Error loading tests</option>';
        console.error('Failed to load tests:', data.message);
      }
    } catch (err) {
      testSelect.innerHTML = '<option value="">Error loading tests</option>';
      console.error('Failed to load tests:', err);
    }
  });

  // ── Level 3: Test selected, show mark button ───────────────────
  testSelect.addEventListener('change', function() {
    var testId = this.value;
    if (testId) {
      markBtn.href = '/tests/mark/' + testId;
      testInfo.textContent = this.options[this.selectedIndex].textContent;
      markAction.style.display = 'flex';
      markAction.style.alignItems = 'center';
    } else {
      markAction.style.display = 'none';
    }
  });
})();
