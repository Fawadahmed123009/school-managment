(function () {
  var sessionsData = window.__SESSIONS_DATA__ || [];

  var sessionSelect = document.getElementById('session');
  var phaseSelect = document.getElementById('phase');
  var weekSelect = document.getElementById('week');
  var phaseField = document.getElementById('phase-field');
  var weekField = document.getElementById('week-field');
  var weekHint = document.getElementById('week-hint');

  if (!sessionSelect) return;

  function updatePhaseOptions() {
    var selected = sessionSelect.options[sessionSelect.selectedIndex];
    var phasesAttr = selected.getAttribute('data-phases');

    phaseSelect.innerHTML = '<option value="">—</option>';
    if (phasesAttr) {
      var phases = JSON.parse(phasesAttr);
      phases.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p._id;
        opt.textContent = p.name;
        phaseSelect.appendChild(opt);
      });
    }

    // Show/hide phase and week fields based on session selection
    if (sessionSelect.value) {
      phaseField.style.display = '';
    } else {
      phaseField.style.display = 'none';
      weekField.style.display = 'none';
      weekSelect.innerHTML = '<option value="">Select a week</option>';
    }

    // Clear week selection when session changes
    weekSelect.innerHTML = '<option value="">Select a week</option>';
    weekField.style.display = 'none';
    weekHint.textContent = '';
  }

  function loadWeeksForPhase() {
    var sessionId = sessionSelect.value;
    var phaseId = phaseSelect.value;

    if (!sessionId || !phaseId) {
      weekField.style.display = 'none';
      weekSelect.innerHTML = '<option value="">Select a week</option>';
      weekHint.textContent = '';
      return;
    }

    // Fetch weeks for this session+phase via API
    fetch('/api/v1/sessions/' + sessionId + '/weeks/' + phaseId, {
      headers: { 'Authorization': 'Bearer ' + (document.cookie.match(/session=([^;]+)/) || [])[1] }
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        weekSelect.innerHTML = '<option value="">Select a week</option>';
        var weeks = data.data || [];
        if (weeks.length === 0) {
          weekHint.textContent = 'No weeks defined for this phase yet. Create weeks from the session management page.';
        } else {
          weekHint.textContent = '';
          weeks.forEach(function (w) {
            var opt = document.createElement('option');
            opt.value = w._id;
            opt.textContent = w.name + ' (' + new Date(w.startDate).toLocaleDateString() + ' \u2013 ' + new Date(w.endDate).toLocaleDateString() + ')';
            weekSelect.appendChild(opt);
          });
        }
        weekField.style.display = '';
      })
      .catch(function () {
        weekField.style.display = '';
        weekHint.textContent = 'Could not load weeks for this phase.';
      });
  }

  sessionSelect.addEventListener('change', updatePhaseOptions);
  phaseSelect.addEventListener('change', loadWeeksForPhase);
})();
