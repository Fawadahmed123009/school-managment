// Analytics period picker on the PDF report form.
//
// Mirrors the Session Report Card's own period cascade (see
// public/js/report-session-bulk.js) but for the Analytics panel only: the
// layout mode the analytics PDF renders is driven by which period field is
// filled — weekId (single-week), phaseId with no week narrowing (full-phase,
// the single-subject pivot) or weekIds[] (multi-week) — see detectAnalyticsMode
// and isFullPhasePeriod in services/academic/pdfReport.service.js. All three
// panels share ONE <form>, so this picker uses its own `analytics*`-prefixed
// submit names and `an-*` ids and can never collide with the other panels.
//
// A full-phase report must also resolve to exactly ONE subject — the pivot has
// no subject grouping, so "All subjects" would try to render several unrelated
// subjects in one meaningless table (the API rejects the same way, see
// generateAnalytics' 400). That's enforced by the submit guard below rather
// than by hiding the "All subjects" option: public/js/report-filter-cascade.js
// rebuilds the Subject list on every upstream change, so a removed option
// would just be re-added on the next Session/Grade/Section change.
(function () {
  var sessionSelect = document.getElementById('an-session');
  var periodSelect = document.getElementById('an-period');
  var phaseSelect = document.getElementById('an-phaseId');
  var weekSelect = document.getElementById('an-weekId');
  var subjectSelect = document.getElementById('an-subject');
  if (!sessionSelect || !periodSelect || !phaseSelect || !weekSelect || !subjectSelect) return;

  var weekField = document.querySelector('.an-period-field[data-an-period-for="weeks"]');
  var weeksPhase = document.getElementById('an-weeks-phase');
  var weekList = document.getElementById('an-week-checkbox-list');

  // Embedded session weeks as [{_id, name, phase, session, startDate}] sorted by
  // startDate — the same copy the Session Report Card panel reads.
  var allWeeks = [];
  try {
    var el = document.getElementById('sr-weeks');
    allWeeks = el ? JSON.parse(el.textContent) : [];
  } catch (e) { allWeeks = []; }

  function fillSelect(selectEl, placeholderLabel, items) {
    if (!selectEl) return;
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
    // Keep the choice when it survives the new narrowing.
    var stillValid = items.some(function (it) { return it.value === previous; });
    selectEl.value = stillValid ? previous : '';
  }

  function selectedSessionOption() { return sessionSelect.options[sessionSelect.selectedIndex]; }

  function selectedPhases() {
    var opt = selectedSessionOption();
    try { return opt && opt.dataset.phases ? JSON.parse(opt.dataset.phases) : []; } catch (e) { return []; }
  }

  function weeksForSession(sessionId) {
    if (!sessionId) return [];
    return allWeeks.filter(function (w) { return String(w.session) === String(sessionId); });
  }

  function rebuildPeriodOptions() {
    var phases = selectedPhases();
    rebuildPhaseSelect(phases);
    rebuildWeekSelect(phases);
    rebuildWeeksPhase(phases);
    rebuildWeekCheckboxList();
    applyPeriod();
  }

  function rebuildPhaseSelect(phases) {
    fillSelect(phaseSelect, '-- Select phase --', (phases || selectedPhases()).map(function (p) { return { value: String(p._id), label: p.name }; }));
  }

  // Single-week picker: only weeks of the chosen session, then narrowed to the
  // chosen phase — same rule as the "Selected weeks" list below, so the two
  // week pickers can never offer different options for the same session/phase.
  function rebuildWeekSelect(phases) {
    phases = phases || selectedPhases();
    var sessionId = sessionSelect.value;
    var phaseId = phaseSelect.value;
    var phaseNameById = {};
    phases.forEach(function (p) { phaseNameById[String(p._id)] = p.name; });
    var shown = weeksForSession(sessionId).filter(function (w) {
      return !phaseId || String(w.phase || '') === String(phaseId);
    });
    fillSelect(weekSelect, sessionId ? '-- Select week --' : '-- Select session first --', shown.map(function (w) {
      var pname = phaseNameById[String(w.phase)];
      return { value: String(w._id), label: pname ? pname + ' \u2014 ' + w.name : w.name };
    }));
  }

  // The "Multi-week (select weeks)" mode asks for a phase first, then lists
  // that phase's weeks to tick.
  function rebuildWeeksPhase(phases) {
    fillSelect(weeksPhase, '-- Select phase first --', (phases || selectedPhases()).map(function (p) { return { value: String(p._id), label: p.name }; }));
  }

  function rebuildWeekCheckboxList() {
    if (!weekList) return;
    weekList.innerHTML = '';
    var sessionId = sessionSelect.value;
    var phaseId = weeksPhase ? weeksPhase.value : '';
    if (!sessionId) {
      weekListHint('Select a session first.');
      return;
    }
    if (!phaseId) {
      weekListHint('Select a phase above to choose its weeks.');
      return;
    }
    var weeksForPhase = allWeeks.filter(function (w) {
      return String(w.session) === String(sessionId) && String(w.phase || '') === String(phaseId);
    });
    if (weeksForPhase.length === 0) {
      weekListHint('This phase has no weeks.');
      return;
    }
    weeksForPhase.forEach(function (w) {
      var lab = document.createElement('label');
      lab.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0 5px 4px;cursor:pointer;font-size:13px;font-weight:400;color:var(--ink);';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = 'analyticsWeekIds';
      cb.value = String(w._id);
      cb.className = 'an-week-cb';
      cb.disabled = periodSelect.value !== 'weeks';
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + w.name));
      weekList.appendChild(lab);
    });
  }

  function weekListHint(msg) {
    var p = document.createElement('p');
    p.className = 'hint';
    p.textContent = msg;
    weekList.appendChild(p);
  }

  // Only the picker the chosen period actually needs stays enabled and submits —
  // a disabled control is never sent, so the server sees at most one of
  // analyticsPhaseId / analyticsWeekId / analyticsWeekIds[] (or none, which
  // keeps the legacy auto-detected layout).
  function applyPeriod() {
    var value = periodSelect.value;
    phaseSelect.disabled = value !== 'phase' || !sessionSelect.value;
    weekSelect.disabled = value !== 'week' || !sessionSelect.value;
    if (weekField) {
      var weeksMode = value === 'weeks';
      weekField.style.display = weeksMode ? '' : 'none';
      if (weeksPhase) weeksPhase.disabled = !weeksMode || !sessionSelect.value;
      weekField.querySelectorAll('input').forEach(function (cb) { cb.disabled = !weeksMode; });
    }
  }

  if (weeksPhase) weeksPhase.addEventListener('change', function () { rebuildWeekSelect(); rebuildWeekCheckboxList(); });
  if (phaseSelect) phaseSelect.addEventListener('change', function () { rebuildWeekSelect(); });
  sessionSelect.addEventListener('change', rebuildPeriodOptions);
  periodSelect.addEventListener('change', applyPeriod);

  // ── submit guard ──────────────────────────────────────────────────────────
  var form = document.getElementById('pdfForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      var reportType = document.getElementById('reportType');
      if (!reportType || reportType.value !== 'analytics') return;
      var period = periodSelect.value;
      var msg = null;
      if (period === 'week') {
        if (!weekSelect.disabled && !weekSelect.value) msg = 'Please select a week (or switch the period).';
      } else if (period === 'phase') {
        if (!phaseSelect.value) msg = 'Please select a phase (or switch the period).';
        else if (!subjectSelect.value) msg = 'A full-phase report must cover exactly one subject — pick a single Subject, not "All subjects".';
      } else if (period === 'weeks') {
        if (!weeksPhase || !weeksPhase.value) msg = 'Please select a phase to choose weeks (or switch the period).';
        else if (!document.querySelectorAll('#an-week-checkbox-list .an-week-cb:checked').length) msg = 'Please tick at least one week to combine.';
      }
      if (msg) {
        e.preventDefault();
        alert(msg);
      }
    });
  }

  // ── init ──────────────────────────────────────────────────────────────────
  applyPeriod();
})();
