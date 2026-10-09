// Session-report extras on the PDF report form.
//
// The pupil picker (Session → Grade → Section → Student → Subject → Test) is now
// the SHARED cascade rendered from views/reports/partials/filter-cascade.ejs and
// wired by public/js/report-filter-cascade.js — identical to Result Sheet and
// Analytics, populated from the role-scoped student list. This script keeps ONLY
// what is specific to a session report:
//
//   • the "Report for" mode toggle (student / whole grade / selected sections),
//   • the bulk class pickers for the whole-grade and selected-sections modes,
//     which resolve to a classLevelIds[] array (they list grades/sections from the
//     classes covered by the chosen session's tests — GET session-students),
//   • the shared period cascade (Whole session / Phase / Week / Selected weeks),
//   • the submit guard.
//
// The hidden #sr-scope input carries what the server reads: 'student' for the
// single flow, 'sections' for both bulk paths (they share classLevelIds[]). The
// unified cascade's Student select (#sr-student) is the single-student submit; the
// bulk modes ignore it and post classLevelIds[] instead. All controls live inside
// the single #pdfForm.
(function () {
  var scopeInput = document.getElementById('sr-scope');
  var sessionSelect = document.getElementById('sr-session');       // from the shared cascade partial
  var periodSelect = document.getElementById('sr-period');
  var phaseSelect = document.getElementById('phaseId_sr');
  var weekSelect = document.getElementById('weekId_sr');
  var studentSelect = document.getElementById('sr-student');       // from the shared cascade partial
  if (!scopeInput || !sessionSelect || !periodSelect || !phaseSelect || !weekSelect || !studentSelect) return;

  var toggleBar = document.getElementById('sr-mode-toggle');
  var modeButtons = toggleBar ? Array.prototype.slice.call(toggleBar.querySelectorAll('[data-sr-mode]')) : [];
  var modePanels = Array.prototype.slice.call(document.querySelectorAll('.sr-mode-panel'));

  // Whole-grade-mode controls.
  var gradeGrade = document.getElementById('sr-grade-grade');
  var gradeSection = document.getElementById('sr-grade-section');
  var gradeHolder = document.getElementById('sr-grade-class-holder');
  var gradeSummary = document.getElementById('sr-grade-summary');

  // Selected-sections-mode controls.
  var secGrade = document.getElementById('sr-sec-grade');
  var secList = document.getElementById('sr-class-checkbox-list');

  // Period controls.
  var weekField = document.querySelector('.sr-period-field[data-sr-period-for="weeks"]');
  var weeksPhase = document.getElementById('sr-weeks-phase');
  var weekList = document.getElementById('sr-week-checkbox-list');

  var NONE_SECTION = '__none__'; // sentinel for a class with no Boys/Girls section

  // Embedded session weeks as [{_id, name, phase, session, startDate}] sorted by startDate.
  var allWeeks = [];
  try {
    var el = document.getElementById('sr-weeks');
    allWeeks = el ? JSON.parse(el.textContent) : [];
  } catch (e) { allWeeks = []; }

  // Classes covered by the chosen session's tests — the whole-grade / selected-
  // sections pickers list grades ONLY from here, so a session's grade options
  // never leak unrelated grades. Loaded via GET session-students (admin/manager);
  // a teacher gets an empty list and therefore no bulk classes (bulk generation
  // is admin/manager only regardless).
  var sessionClasses = [];

  // Checked class ids survive a grade switch in sections mode.
  var checkedClassIds = {};

  var currentMode = 'student';

  // ── helpers ───────────────────────────────────────────────────────────────
  function setDisabled(container, disabled) {
    if (!container) return;
    container.querySelectorAll('select, input').forEach(function (elm) { elm.disabled = disabled; });
  }

  function getHeaders() {
    var headers = {};
    var meta = document.querySelector('meta[name="auth-token"]');
    if (meta && meta.content) headers['Authorization'] = 'Bearer ' + meta.content;
    return headers;
  }

  // Grade sort: PG first, then numeric ascending.
  function gradeSort(a, b) {
    var rank = function (g) { return g === 'PG' ? -1 : parseInt(g, 10); };
    return rank(a) - rank(b);
  }

  function sectionKey(sec) { return sec || NONE_SECTION; }

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

  // ── mode toggle ───────────────────────────────────────────────────────────
  // Inactive bulk panels are disabled so their classLevelIds never submit — a
  // stale array would otherwise override the picked mode. The "student" mode has
  // no dedicated panel; the shared cascade above is the picker.
  function applyMode() {
    scopeInput.value = currentMode === 'student' ? 'student' : 'sections';
    modeButtons.forEach(function (btn) {
      btn.className = btn.dataset.srMode === currentMode ? 'btn btn-primary' : 'btn btn-ghost';
    });
    modePanels.forEach(function (panel) {
      var active = panel.dataset.srModeFor === currentMode;
      panel.style.display = active ? '' : 'none';
      setDisabled(panel, !active);
    });
    syncClassPickersEnabled();
  }

  // The grade/sections pickers are pure filters (no `name`); the real submit is
  // the classLevelIds inputs. Still, before a session is chosen their selects
  // must be locked so the panel doesn't suggest grades are available.
  function syncClassPickersEnabled() {
    var hasSession = !!sessionSelect.value;
    if (currentMode === 'grade') {
      if (gradeGrade) gradeGrade.disabled = !hasSession;
      if (gradeSection) gradeSection.disabled = !hasSession || !gradeGrade || !gradeGrade.value;
    } else if (currentMode === 'sections') {
      if (secGrade) secGrade.disabled = !hasSession;
    }
  }

  // Rebuild the whole-grade and selected-sections pickers from the session's
  // in-scope classes. Called whenever the session (and therefore sessionClasses)
  // changes.
  function refreshClassScopePickers() {
    buildGradeModeOptions();
    buildSectionsGradeOptions();
    syncClassPickersEnabled();
  }

  modeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      currentMode = btn.dataset.srMode;
      applyMode();
    });
  });

  // ── session-scoped classes (for the bulk pickers only) ────────────────────
  function loadSessionClasses() {
    var sessionId = sessionSelect.value;
    if (!sessionId) {
      sessionClasses = [];
      refreshClassScopePickers();
      return;
    }
    sessionClasses = [];
    refreshClassScopePickers();
    fetch('/api/v1/pdf-reports/session-students?sessionId=' + encodeURIComponent(sessionId), { headers: getHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var payload = (data && data.status === 'success' && data.data) ? data.data : {};
        sessionClasses = (payload.classes || []).map(function (c) {
          return { _id: String(c._id), gradeLevel: c.gradeLevel || null, section: c.section || null, name: c.name, group: c.group || null };
        });
        refreshClassScopePickers();
      })
      .catch(function () {
        sessionClasses = [];
        refreshClassScopePickers();
      });
  }

  // ── grade + sections modes: build from the session-scoped class list ─────
  function distinctGrades() {
    var keys = {};
    sessionClasses.forEach(function (c) { if (c.gradeLevel) keys[c.gradeLevel] = true; });
    return Object.keys(keys).sort(gradeSort);
  }

  function classesForGrade(grade) {
    return sessionClasses.filter(function (c) { return c.gradeLevel === grade; });
  }

  // Placeholder text reflects whether a session (and therefore any in-scope
  // grade) is available yet.
  function gradePlaceholder() {
    if (!sessionSelect.value) return '-- Select session first --';
    return distinctGrades().length ? '-- Select grade --' : 'No grades in this session';
  }

  function buildGradeModeOptions() {
    fillSelect(gradeGrade, gradePlaceholder(), distinctGrades().map(function (g) { return { value: g, label: 'Grade ' + g }; }));
    buildGradeSectionOptions();
    resolveGradeClasses();
  }

  function buildGradeSectionOptions() {
    var g = gradeGrade ? gradeGrade.value : '';
    if (!g) { fillSelect(gradeSection, '-- Select grade first --', []); return; }
    var keys = {};
    classesForGrade(g).forEach(function (c) { keys[sectionKey(c.section)] = true; });
    fillSelect(gradeSection, 'Whole grade (all sections)', Object.keys(keys).map(function (k) {
      return { value: k, label: k === NONE_SECTION ? 'No section' : k };
    }));
  }

  // Resolve the picked grade (+ optional section) to every matching class, then
  // submit those class ids as classLevelIds[] via the hidden holder.
  function resolveGradeClasses() {
    if (!gradeHolder) return;
    gradeHolder.innerHTML = '';
    var g = gradeGrade ? gradeGrade.value : '';
    if (!g) {
      if (gradeSummary) gradeSummary.textContent = 'Select a grade and section to include every matching class.';
      return;
    }
    var secVal = gradeSection ? gradeSection.value : '';
    var matched = classesForGrade(g).filter(function (c) {
      if (!secVal) return true;
      return sectionKey(c.section) === secVal;
    });
    matched.forEach(function (c) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'classLevelIds';
      input.value = c._id;
      gradeHolder.appendChild(input);
    });
    // Holder inputs are hidden (always "on"); respect the active mode's enabled
    // state — applyMode() toggles the whole panel's disabled flag.
    if (gradeSummary) {
      var scopeTxt = secVal ? ('section ' + (secVal === NONE_SECTION ? 'with no split' : secVal)) : 'all sections';
      gradeSummary.textContent = matched.length
        ? (matched.length + ' class' + (matched.length === 1 ? '' : 'es') + ' in grade ' + g + ' (' + scopeTxt + ') will each get report cards.')
        : 'No classes match this grade / section.';
    }
  }

  if (gradeGrade) gradeGrade.addEventListener('change', function () { buildGradeSectionOptions(); resolveGradeClasses(); syncClassPickersEnabled(); });
  if (gradeSection) gradeSection.addEventListener('change', resolveGradeClasses);

  // ── sections mode: grade → tick that grade's class/es ────────────────────
  function buildSectionsGradeOptions() {
    fillSelect(secGrade, gradePlaceholder(), distinctGrades().map(function (g) { return { value: g, label: 'Grade ' + g }; }));
    renderSectionsList();
  }

  function renderSectionsList() {
    if (!secList) return;
    secList.innerHTML = '';
    var g = secGrade ? secGrade.value : '';
    if (!g) {
      var empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Select a grade to list its sections.';
      secList.appendChild(empty);
      return;
    }
    var groupClasses = classesForGrade(g);
    var group = document.createElement('div');
    group.className = 'grade-group';
    group.setAttribute('data-grade', g);

    if (groupClasses.length > 1) {
      var allLabel = document.createElement('label');
      allLabel.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;font-weight:600;text-transform:none;letter-spacing:0;color:var(--ink-soft);border-bottom:1px dashed var(--border);margin-bottom:4px;cursor:pointer;';
      var allCb = document.createElement('input');
      allCb.type = 'checkbox';
      allCb.className = 'grade-all-cb';
      allCb.checked = groupClasses.every(function (c) { return checkedClassIds[c._id]; });
      allLabel.appendChild(allCb);
      allLabel.appendChild(document.createTextNode(' All sections of grade ' + g));
      group.appendChild(allLabel);
    }

    groupClasses.forEach(function (c) {
      var lab = document.createElement('label');
      lab.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0 5px 22px;cursor:pointer;font-size:13px;text-transform:none;letter-spacing:0;font-weight:400;color:var(--ink);';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.name = 'classLevelIds';
      cb.value = c._id;
      cb.className = 'class-cb';
      cb.checked = !!checkedClassIds[c._id];
      cb.disabled = currentMode !== 'sections';
      lab.appendChild(cb);
      var text = (c.gradeLevel ? c.gradeLevel + ' \u2014 ' : '') + c.name + (c.group ? ' (' + c.group + ')' : '') + (c.section ? ' \u00b7 ' + c.section : '');
      lab.appendChild(document.createTextNode(' ' + text));
      group.appendChild(lab);
    });

    secList.appendChild(group);
  }

  // Delegated grade-all toggle + indeterminate sync (list is rebuilt per grade).
  if (secList) {
    secList.addEventListener('change', function (e) {
      var t = e.target;
      if (t.classList.contains('grade-all-cb')) {
        var grp = t.closest('.grade-group');
        if (grp) grp.querySelectorAll('.class-cb').forEach(function (cb) {
          cb.checked = t.checked;
          checkedClassIds[cb.value] = t.checked;
        });
        t.indeterminate = false;
        return;
      }
      if (t.classList.contains('class-cb')) {
        checkedClassIds[t.value] = t.checked;
        var g = t.closest('.grade-group');
        if (!g) return;
        var all = g.querySelector('.grade-all-cb');
        if (!all) return;
        var boxes = g.querySelectorAll('.class-cb');
        var checkedCount = g.querySelectorAll('.class-cb:checked').length;
        all.checked = checkedCount === boxes.length;
        all.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
      }
    });
  }

  if (secGrade) secGrade.addEventListener('change', renderSectionsList);

  // ── period cascade ───────────────────────────────────────────────────────
  function rebuildPeriodOptions() {
    var phases = selectedPhases();
    var sessionId = sessionSelect.value;
    fillSelect(phaseSelect, '-- Select phase --', phases.map(function (p) { return { value: String(p._id), label: p.name }; }));
    var phaseNameById = {};
    phases.forEach(function (p) { phaseNameById[String(p._id)] = p.name; });
    // Label weeks with their owning phase — "Week 1" repeats across phases.
    fillSelect(weekSelect, '-- Select week --', allWeeks
      .filter(function (w) { return String(w.session) === String(sessionId); })
      .map(function (w) {
        var pname = phaseNameById[String(w.phase)];
        return { value: String(w._id), label: pname ? pname + ' \u2014 ' + w.name : w.name };
      }));
    rebuildWeeksPhase();
    rebuildWeekCheckboxList();
    applyPeriod();
  }

  // The "Selected weeks" period asks for a phase first, then lists that phase's
  // weeks to tick.
  function rebuildWeeksPhase() {
    var phases = selectedPhases();
    fillSelect(weeksPhase, '-- Select phase first --', phases.map(function (p) { return { value: String(p._id), label: p.name }; }));
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
      cb.name = 'weekIds';
      cb.value = String(w._id);
      cb.className = 'week-cb';
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

  // Only the picker the period actually needs stays enabled and submits — a
  // disabled control is never sent, so the server sees exactly one of
  // phaseId / weekId / weekIds[] (or none for the whole session).
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

  if (weeksPhase) weeksPhase.addEventListener('change', rebuildWeekCheckboxList);
  sessionSelect.addEventListener('change', function () { loadSessionClasses(); rebuildPeriodOptions(); });
  periodSelect.addEventListener('change', applyPeriod);

  // ── submit guard ──────────────────────────────────────────────────────────
  var form = document.getElementById('pdfForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      var reportType = document.getElementById('reportType');
      if (!reportType || reportType.value !== 'session-report') return;
      var msg = null;
      if (!sessionSelect.value) {
        msg = 'Please select a session.';
      } else if (currentMode === 'student') {
        if (!studentSelect.value) msg = 'Please select a student.';
      } else if (currentMode === 'grade') {
        if (!gradeGrade || !gradeGrade.value) msg = 'Please select a grade.';
        else if (!gradeHolder || !gradeHolder.querySelectorAll('input[name="classLevelIds"]').length) msg = 'No classes match this grade / section.';
      } else if (currentMode === 'sections') {
        if (!secGrade || !secGrade.value) msg = 'Please select a grade, then tick at least one section.';
        else if (!document.querySelectorAll('#sr-class-checkbox-list .class-cb:checked').length) msg = 'Please tick at least one section.';
      }
      if (!msg && periodSelect.value === 'phase' && !phaseSelect.disabled && !phaseSelect.value) msg = 'Please select a phase (or switch the period).';
      if (!msg && periodSelect.value === 'week' && !weekSelect.disabled && !weekSelect.value) msg = 'Please select a week (or switch the period).';
      if (!msg && periodSelect.value === 'weeks') {
        if (!weeksPhase || !weeksPhase.value) msg = 'Please select a phase to choose weeks (or switch the period).';
        else if (!document.querySelectorAll('#sr-week-checkbox-list .week-cb:checked').length) msg = 'Please tick at least one week to combine.';
      }
      if (msg) {
        e.preventDefault();
        alert(msg);
      }
    });
  }

  // ── init ──────────────────────────────────────────────────────────────────
  buildGradeModeOptions();
  buildSectionsGradeOptions();
  applyMode();
  applyPeriod();
})();
