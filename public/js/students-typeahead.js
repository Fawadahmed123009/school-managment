// Searchable Student picker for the All-Students filter bar
// (views/students/list.ejs).
//
// Builds on the ONE shared typeahead component (public/js/student-typeahead.js,
// loaded before this file — the same one the Fee add-record selector and every
// Student level of the PDF-report cascade use). This file owns only the page
// wiring: which pupils the picker may offer, and where a committed pick goes.
//
//   • Pool    — the full roster embedded by the template as a non-executed JSON
//               island (#students-typeahead-pool). Admin/Manager page, so every
//               pupil is present.
//   • Scoping — items() re-reads the current Grade / Section / Class / Status
//               selects on EVERY render, so the dropdown can only ever list
//               pupils those filters still allow (live narrowing, exactly like
//               the cascade panels above it). Status mirrors the server's
//               STATUS_CLAUSES so what you see is what submitting returns.
//   • Commit  — picking a row writes the hidden `name` control (the value
//               GET /students already filters on) and submits the filter form,
//               so the table narrows to that pupil while the other filters ride
//               along in the same form. Typing without picking clears the hidden
//               value, so a half-typed name is never submitted as a selection.
//
// Bound from an external file on purpose: helmet sets script-src 'self' (no
// 'unsafe-inline'), so an inline <script> in the view would be blocked.
(function () {
  var searchInput = document.getElementById('st-student-search');
  var hiddenName  = document.getElementById('st-student-name');
  var resultsBox  = document.getElementById('st-student-results');
  var form        = document.getElementById('st-filter-form');
  if (!searchInput || !hiddenName || !resultsBox || !window.initStudentTypeahead) return;

  var gradeSel   = document.getElementById('st-filter-grade');
  var sectionSel = document.getElementById('st-filter-section');
  var classSel   = document.getElementById('st-filter-class');
  var statusSel  = document.getElementById('st-filter-status');

  var POOL = (function () {
    var el = document.getElementById('students-typeahead-pool');
    if (el) { try { return JSON.parse(el.textContent); } catch (e) {} }
    return [];
  })();

  // Committed pick, remembered for the label the box restores on blur.
  var picked = null;

  // Mirror the server STATUS_CLAUSES (routes/views/students.views.js). Note
  // "enrolled" keeps suspended pupils — the server clause does too.
  function statusAllows(s, status) {
    switch (status) {
      case 'enrolled':  return s.status !== 'inactive' && !s.isGraduated && !s.isWithdrawn;
      case 'inactive':  return s.status === 'inactive';
      case 'graduated': return !!s.isGraduated;
      case 'withdrawn': return !!s.isWithdrawn;
      case 'suspended': return !!s.isSuspended;
      default:          return true;
    }
  }

  var picker = window.initStudentTypeahead({
    input: searchInput,
    results: resultsBox,
    // LIVE pool: the cascade selects narrow it, so a pupil outside the current
    // Grade/Section/Class/Status scope can never be offered or committed.
    items: function () {
      var g   = gradeSel   ? gradeSel.value   : '';
      var sec = sectionSel ? sectionSel.value : '';
      var cls = classSel   ? classSel.value   : '';
      var st  = statusSel  ? statusSel.value  : '';
      return POOL.filter(function (s) {
        if (cls && s.classId !== cls) return false;
        if (g && s.grade !== g) return false;
        if (sec && s.section !== sec) return false;
        if (st && !statusAllows(s, st)) return false;
        return true;
      }).map(function (s) {
        return {
          id: s.id,
          title: s.name,
          label: s.name + ' (' + (s.rollNumber || '\u2014') + ')',
          subtitle: 'Roll ' + (s.rollNumber || '\u2014') +
            ' \u00b7 ' + (s.className || 'Unassigned') +
            (s.section ? ' \u00b7 ' + s.section : ''),
          // name OR roll number, as the fee picker did
          keywords: (s.name + ' ' + String(s.rollNumber)).toLowerCase(),
        };
      });
    },
    getSelected: function () { return picked; },
    onSelect: function (item) {
      picked = { id: item.id, label: item.title };
      hiddenName.value = item.title;
      // Narrow the table to this pupil — the other filter controls are in this
      // same form, so their current selections carry over untouched.
      if (form && form.submit) form.submit();
    },
    onInvalidate: function () {
      picked = null;
      hiddenName.value = '';
    },
  });

  // A change above the picker can drop the committed pupil out of scope, so drop
  // the pick (and the hidden value) rather than submit a stale one.
  function onScopeChange() { picker.invalidate(); }
  [gradeSel, sectionSel, classSel, statusSel].forEach(function (el) {
    if (el) el.addEventListener('change', onScopeChange);
  });

  // A fresh load that carried ?name=… (a pick that submitted, a paginated link,
  // or a reload after "Filter") keeps that value as the committed pick: the box
  // shows it, blur restores it, and it stays the submitted substring — so the
  // old free-text search still behaves across reloads.
  (function restore() {
    var current = String(hiddenName.value || '').trim();
    if (current) picked = { id: null, label: current };
  })();
})();
