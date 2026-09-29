/**
 * Edit-test form cascade (Session → Phase → Week).
 *
 * The page renders the test's current placement server-side (including the
 * phase and week options that match it), so this script only has to rebuild
 * the dependent lists once the admin/manager changes session or phase — the
 * same behaviour as the create form in test-manage.js.
 */
(function () {
  var sessionSelect = document.getElementById('session');
  var phaseSelect = document.getElementById('phase');
  var weekSelect = document.getElementById('week');
  var phaseField = document.getElementById('phase-field');
  var weekField = document.getElementById('week-field');
  var weekHint = document.getElementById('week-hint');

  if (!sessionSelect || !phaseSelect || !weekSelect || !phaseField || !weekField) return;

  // The session cookie is httpOnly, so it can't be read from document.cookie.
  // Read the JWT from the server-rendered <meta name="auth-token"> tag instead,
  // matching every other authenticated fetch in the app (see test-cascade-*.js).
  function getAuthHeaders() {
    var headers = {};
    var meta = document.querySelector('meta[name="auth-token"]');
    if (meta && meta.content) headers['Authorization'] = 'Bearer ' + meta.content;
    return headers;
  }

  function resetWeekSelect() {
    weekSelect.innerHTML = '<option value="">Select a week</option>';
    weekField.style.display = 'none';
    if (weekHint) weekHint.textContent = '';
  }

  function updatePhaseOptions() {
    var selected = sessionSelect.options[sessionSelect.selectedIndex];
    var phasesAttr = selected ? selected.getAttribute('data-phases') : null;

    phaseSelect.innerHTML = '<option value="">—</option>';
    if (phasesAttr) {
      try {
        JSON.parse(phasesAttr).forEach(function (p) {
          var opt = document.createElement('option');
          opt.value = p._id;
          opt.textContent = p.name;
          phaseSelect.appendChild(opt);
        });
      } catch (e) { /* leave the list empty rather than killing the handlers */ }
    }

    if (sessionSelect.value) {
      phaseField.style.display = '';
    } else {
      phaseField.style.display = 'none';
    }
    resetWeekSelect();
  }

  function loadWeeksForPhase() {
    var sessionId = sessionSelect.value;
    var phaseId = phaseSelect.value;

    if (!sessionId || !phaseId) {
      resetWeekSelect();
      return;
    }

    fetch('/api/v1/sessions/' + sessionId + '/weeks/' + phaseId, {
      headers: getAuthHeaders()
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        weekSelect.innerHTML = '<option value="">Select a week</option>';
        var weeks = data.data || [];
        if (weeks.length === 0) {
          if (weekHint) weekHint.textContent = 'No weeks defined for this phase yet. Create weeks from the session management page.';
        } else {
          if (weekHint) weekHint.textContent = '';
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
        if (weekHint) weekHint.textContent = 'Could not load weeks for this phase.';
      });
  }

  sessionSelect.addEventListener('change', updatePhaseOptions);
  phaseSelect.addEventListener('change', loadWeeksForPhase);
})();
