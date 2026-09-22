/**
 * Teacher-analytics class filter — a checkbox group (no AJAX; the surrounding
 * GET form simply submits the ticked classLevel values on Apply).
 *
 * Mirrors the marking picker's grade grouping:
 *   • each multi-section grade has an "All sections of grade X" helper checkbox
 *     (not named, so it is never submitted) that toggles its section boxes;
 *   • grade helpers reflect partial selection via the indeterminate state;
 *   • "Select all" / "Clear" act across every section.
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
      updateCount();
    });
  });

  // Section change → keep grade helper + count in sync.
  classCheckboxes.forEach(function (cb) {
    cb.addEventListener('change', function () {
      syncGradeBoxes();
      updateCount();
    });
  });

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', function () {
      classCheckboxes.forEach(function (cb) { cb.checked = true; });
      syncGradeBoxes();
      updateCount();
    });
  }
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', function () {
      classCheckboxes.forEach(function (cb) { cb.checked = false; });
      syncGradeBoxes();
      updateCount();
    });
  }

  // Initialise from the server-rendered (restored) selection.
  syncGradeBoxes();
  updateCount();
})();
