/**
 * Analytics class filter — a checkbox group (no AJAX; the surrounding
 * GET form simply submits the ticked classLevel values on Apply).
 *
 * Mirrors the marking picker's grade grouping:
 *   • each multi-section grade has an "All sections of grade X" helper checkbox
 *     (not named, so it is never submitted) that toggles its section boxes;
 *   • grade helpers reflect partial selection via the indeterminate state;
 *   • "Select all" / "Clear" act across every section.
 *
 * On the admin analytics page the list is additionally wrapped in a
 * select-styled dropdown (#ana-class-trigger / #ana-class-panel). The "All
 * classes" row clears every tick so the form submits no classLevelId tokens
 * (= no restriction). All dropdown wiring is guarded, so the teacher page
 * (plain always-open list) keeps working unchanged.
 */
(function () {
  var list = document.getElementById('ana-class-list');
  if (!list) return;

  var classCheckboxes = list.querySelectorAll('.class-cb');
  var gradeCheckboxes = list.querySelectorAll('.grade-all-cb');
  var selectAllBtn = document.getElementById('ana-select-all');
  var clearAllBtn = document.getElementById('ana-clear-all');
  var countEl = document.getElementById('ana-class-count');

  function selectedCount() {
    var n = 0;
    classCheckboxes.forEach(function (cb) { if (cb.checked) n++; });
    return n;
  }

  function updateCount() {
    if (!countEl) return;
    var n = selectedCount();
    countEl.textContent = n > 0 ? n + ' selected' : 'all';
  }

  // Dropdown trigger summary (admin page only): "All classes" or "N classes".
  var summaryEl = document.getElementById('ana-class-summary');
  function updateSummary() {
    if (!summaryEl) return;
    var n = selectedCount();
    summaryEl.textContent = n > 0 ? n + ' class' + (n === 1 ? '' : 'es') : 'All classes';
  }

  // ── Student picker (Trend — Student) ──────────────────────────────────
  // The class filter lives directly above the Student dropdown and acts as a
  // live search for it: only students whose class is ticked remain in the
  // list (all students when nothing is ticked). Options carry data-cls so no
  // round-trip is needed. Guarded — absent on the class-trend / teacher pages.
  var studentSel = document.getElementById('studentId');
  var studentOpts = studentSel
    ? Array.prototype.slice.call(studentSel.options).filter(function (o) { return o.value !== ''; })
    : [];
  function refreshStudentOptions() {
    if (!studentSel) return;
    var picked = {};
    var any = false;
    list.querySelectorAll('.class-cb:checked').forEach(function (cb) { picked[cb.value] = true; any = true; });
    studentOpts.forEach(function (o) {
      var cls = o.getAttribute('data-cls') || '';
      o.hidden = any ? !(cls && picked[cls]) : false;
    });
    // Drop a selection that just fell out of scope so we never submit it.
    var current = studentSel.value;
    if (current) {
      var co = studentSel.querySelector('option[value="' + current + '"]');
      if (co && co.hidden) studentSel.value = '';
    }
  }

  function refresh() {
    updateCount();
    updateSummary();
    refreshStudentOptions();
  }

  /** Sync each grade helper's checked/indeterminate state from its sections. */
  function syncGradeBoxes() {
    list.querySelectorAll('.grade-group').forEach(function (group) {
      var gradeCb = group.querySelector('.grade-all-cb');
      if (!gradeCb) return;
      var boxes = group.querySelectorAll('.class-cb');
      var checked = 0;
      boxes.forEach(function (cb) { if (cb.checked) checked++; });
      gradeCb.checked = checked === boxes.length && boxes.length > 0;
      gradeCb.indeterminate = checked > 0 && checked < boxes.length;
    });
  }

  // Grade helper → check/uncheck every section in that grade.
  gradeCheckboxes.forEach(function (gradeCb) {
    gradeCb.addEventListener('change', function () {
      var group = this.closest('.grade-group');
      if (!group) return;
      var checked = this.checked;
      group.querySelectorAll('.class-cb').forEach(function (cb) { cb.checked = checked; });
      this.indeterminate = false;
      refresh();
    });
  });

  // Section change → keep grade helper + count in sync.
  classCheckboxes.forEach(function (cb) {
    cb.addEventListener('change', function () {
      syncGradeBoxes();
      refresh();
    });
  });

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', function () {
      classCheckboxes.forEach(function (cb) { cb.checked = true; });
      syncGradeBoxes();
      refresh();
    });
  }
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', function () {
      classCheckboxes.forEach(function (cb) { cb.checked = false; });
      syncGradeBoxes();
      refresh();
    });
  }

  // ── Dropdown presentation (admin analytics only) ──────────────────────
  var trigger = document.getElementById('ana-class-trigger');
  var panel = document.getElementById('ana-class-panel');
  var allClassesCb = document.getElementById('ana-all-classes');
  if (trigger && panel) {
    function setOpen(open) {
      panel.hidden = !open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(panel.hidden);
    });
    // Clicks inside the panel (including the "All classes" row) must not close it.
    panel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
    // "All classes" = clear every tick → no tokens submitted → no restriction.
    if (allClassesCb) {
      allClassesCb.addEventListener('change', function () {
        if (this.checked) {
          classCheckboxes.forEach(function (cb) { cb.checked = false; });
          syncGradeBoxes();
          refresh();
        }
      });
    }
    setOpen(false);
    trigger.setAttribute('aria-expanded', 'false');
  }

  // Initialise from the server-rendered (restored) selection.
  syncGradeBoxes();
  refresh();
})();
