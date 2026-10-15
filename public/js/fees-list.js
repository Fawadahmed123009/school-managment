// Fee-record form helpers, externalized from views/fees/list.ejs (CSP: the page
// carries no inline <script>). Two behaviours:
//   1. Auto-fill the amount when a fee head with a default is chosen.
//   2. A searchable student picker — the class and roll-number filters narrow
//      the picker's pool, and the typing/search/commit behaviour lives in the
//      SHARED component (public/js/student-typeahead.js, loaded before this
//      file) so the PDF-report cascade uses the exact same implementation.
// The student list (a few hundred rows) is still embedded by the template as a
// non-executed JSON island (#fees-students); this file only decides which of
// those rows the current class/roll filters allow.
(function () {
  // Auto-fill amount when a fee head with a default is selected
  var feeHead = document.getElementById('feeHead');
  if (feeHead) {
    feeHead.addEventListener('change', function () {
      var opt = this.options[this.selectedIndex];
      var amt = opt && opt.dataset.amount;
      if (amt && Number(amt) > 0) {
        document.getElementById('amount').value = amt;
      }
    });
  }

  // ---- Searchable student picker (shared typeahead) ----
  var STUDENTS = (function () {
    var el = document.getElementById('fees-students');
    if (el) { try { return JSON.parse(el.textContent); } catch (e) {} }
    return [];
  })();

  var searchInput = document.getElementById('student-search');
  var hiddenInput = document.getElementById('student');
  var resultsBox  = document.getElementById('student-results');
  var classFilter = document.getElementById('filter-class');
  var rollFilter  = document.getElementById('filter-roll');
  if (!searchInput || !hiddenInput || !resultsBox || !window.initStudentTypeahead) return;

  // Committed pick, remembered for the label the box restores on blur.
  var picked = null;

  var picker = window.initStudentTypeahead({
    input: searchInput,
    results: resultsBox,
    // LIVE pool: the class/roll filters above are applied here, so the
    // typeahead can only ever offer pupils those filters still allow.
    items: function () {
      var classVal = classFilter ? classFilter.value : '';
      var rollVal  = rollFilter ? rollFilter.value.trim().toLowerCase() : '';
      return STUDENTS.filter(function (s) {
        if (classVal && s.classId !== classVal) return false;
        if (rollVal && String(s.rollNumber).toLowerCase().indexOf(rollVal) === -1) return false;
        return true;
      }).map(function (s) {
        return {
          id: s.id,
          title: s.name,
          subtitle: 'Roll ' + (s.rollNumber || '\u2014') + ' \u00b7 ' + s.className + ' (' + s.section + ')',
          // name OR roll number, as before
          keywords: (s.name + ' ' + String(s.rollNumber)).toLowerCase(),
        };
      });
    },
    openOnEmpty: true,
    getSelected: function () { return picked; },
    onSelect: function (item) {
      picked = { id: item.id, label: item.title };
      hiddenInput.value = item.id;
    },
    onInvalidate: function () {
      // Any edit invalidates the previous selection until a row is picked again.
      picked = null;
      hiddenInput.value = '';
    },
  });

  // Filter changes invalidate the pick and re-list the pupils now in scope
  // (a pupil picked under the old class/roll filter is stale; the fee page has
  // always shown its matches as soon as a filter is set).
  function onFilterChange() {
    picker.invalidate();
    picker.open();
  }
  if (classFilter) classFilter.addEventListener('change', onFilterChange);
  if (rollFilter)  rollFilter.addEventListener('input', onFilterChange);

  document.querySelector('form[action="/fees/create"]').addEventListener('submit', function (e) {
    if (!hiddenInput.value) {
      e.preventDefault();
      alert('Please select a student from the search results.');
    }
  });
})();
