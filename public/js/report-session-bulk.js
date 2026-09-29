// Session-report picker: scope toggle (student / class / sections),
// period cascade (Session → Phase / Week) and the grade-group section
// checkbox toggles. Follows the report-generate page conventions — all
// elements live inside the single #pdfForm.
(function () {
  var scopeSelect = document.getElementById('sr-scope');
  var sessionSelect = document.getElementById('sessionId_sr');
  var periodSelect = document.getElementById('sr-period');
  var phaseSelect = document.getElementById('phaseId_sr');
  var weekSelect = document.getElementById('weekId_sr');
  if (!scopeSelect || !sessionSelect || !periodSelect || !phaseSelect || !weekSelect) return;

  var scopeFields = document.querySelectorAll('.sr-scope-field');

  function setDisabled(container, disabled) {
    container.querySelectorAll('select, input').forEach(function (el) { el.disabled = disabled; });
  }

  // Hidden scope fields must not submit: disable their controls so the
  // browser omits them entirely (a stale classLevelIds array would
  // override the picked scope server-side).
  function applyScope() {
    var value = scopeSelect.value;
    scopeFields.forEach(function (el) {
      var active = el.dataset.srFor === value;
      el.style.display = active ? '' : 'none';
      // Never lock the student picker out — its control ids live here.
      setDisabled(el, !active);
    });
  }

  function setOptions(select, items, placeholder) {
    select.innerHTML = '';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = placeholder;
    select.appendChild(ph);
    items.forEach(function (it) {
      var opt = document.createElement('option');
      opt.value = it.value;
      opt.textContent = it.label;
      select.appendChild(opt);
    });
  }

  // Weeks are embedded by the page as [{_id, name, phase, session, startDate}]
  // sorted by startDate. Parsed once; filtered per selected session/phase.
  var allWeeks = [];
  try {
    var el = document.getElementById('sr-weeks');
    allWeeks = el ? JSON.parse(el.textContent) : [];
  } catch (e) { allWeeks = []; }

  function selectedSessionOption() {
    return sessionSelect.options[sessionSelect.selectedIndex];
  }

  function rebuildPeriodOptions() {
    var opt = selectedSessionOption();
    var phases = [];
    try { phases = opt && opt.dataset.phases ? JSON.parse(opt.dataset.phases) : []; } catch (e) { phases = []; }
    var sessionId = sessionSelect.value;
    setOptions(phaseSelect, phases.map(function (p) { return { value: String(p._id), label: p.name }; }), '-- Select phase --');
    // Label weeks with their owning phase — "Week 1" repeats across phases.
    var phaseNameById = {};
    phases.forEach(function (p) { phaseNameById[String(p._id)] = p.name; });
    setOptions(weekSelect, allWeeks
      .filter(function (w) { return String(w.session) === String(sessionId); })
      .map(function (w) {
        var pname = phaseNameById[String(w.phase)];
        return { value: String(w._id), label: pname ? pname + ' \u2014 ' + w.name : w.name };
      }), '-- Select week --');
    applyPeriod();
  }

  // Only the picker the period actually needs stays enabled — a disabled
  // select is never submitted, so the server sees exactly one of
  // phaseId / weekId (or neither for the whole session).
  function applyPeriod() {
    var value = periodSelect.value;
    phaseSelect.disabled = value !== 'phase' || !sessionSelect.value;
    weekSelect.disabled = value !== 'week' || !sessionSelect.value;
  }

  scopeSelect.addEventListener('change', applyScope);
  sessionSelect.addEventListener('change', rebuildPeriodOptions);
  periodSelect.addEventListener('change', applyPeriod);
  applyScope();
  applyPeriod();

  // ── Grade-group toggles for the sections checkbox list ─────────────────
  document.querySelectorAll('.grade-all-cb').forEach(function (gradeCb) {
    gradeCb.addEventListener('change', function () {
      var group = this.closest('.grade-group');
      if (!group) return;
      group.querySelectorAll('.class-cb').forEach(function (cb) { cb.checked = gradeCb.checked; });
      this.indeterminate = false;
    });
  });
  document.querySelectorAll('.grade-group').forEach(function (group) {
    var gradeCb = group.querySelector('.grade-all-cb');
    if (!gradeCb) return;
    group.querySelectorAll('.class-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var boxes = group.querySelectorAll('.class-cb');
        var checked = group.querySelectorAll('.class-cb:checked').length;
        gradeCb.checked = checked === boxes.length;
        gradeCb.indeterminate = checked > 0 && checked < boxes.length;
      });
    });
  });

  // ── Submit guard ────────────────────────────────────────────────────────
  var form = document.getElementById('pdfForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      var reportType = document.getElementById('reportType');
      if (!reportType || reportType.value !== 'session-report') return;
      var msg = null;
      if (!sessionSelect.value) {
        msg = 'Please select a session.';
      } else if (scopeSelect.value === 'student') {
        var stu = document.getElementById('studentId_sr');
        if (!stu || !stu.value) msg = 'Please select a student.';
      } else if (scopeSelect.value === 'class') {
        var cls = document.getElementById('classLevelId_sr');
        if (!cls || !cls.value) msg = 'Please select a class.';
      } else if (scopeSelect.value === 'sections') {
        if (!document.querySelectorAll('#sr-class-checkbox-list .class-cb:checked').length) {
          msg = 'Please tick at least one section.';
        }
      }
      if (!msg && periodSelect.value === 'phase' && !phaseSelect.disabled && !phaseSelect.value) msg = 'Please select a phase (or switch the period).';
      if (!msg && periodSelect.value === 'week' && !weekSelect.disabled && !weekSelect.value) msg = 'Please select a week (or switch the period).';
      if (msg) {
        e.preventDefault();
        alert(msg);
      }
    });
  }
})();
