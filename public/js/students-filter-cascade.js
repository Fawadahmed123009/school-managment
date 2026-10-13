/**
 * Grade → Section → Class cascade for the students ledger filter bar
 * (views/students/list.ejs).
 *
 * Mirrors the pupil funnel in report-filter-cascade.js (same keep-still-valid /
 * clear-stale semantics), but reads its pool from the Class options'
 * data-grade / data-section attributes — every class is already in the DOM, so
 * no extra fetch is needed. Server-side, grade + section resolve to a classLevel
 * `$in`, so the submitted filter stays correct without JS and across pages; this
 * file only narrows the visible option lists to match.
 *
 * Bound from an external file on purpose: helmet sets
 * script-src 'self' https://cdn.jsdelivr.net (no 'unsafe-inline'), so an inline
 * <script> in the view is blocked and never runs — the Class dropdown would keep
 * showing every class regardless of the Grade picked. External files load under
 * 'self' and execute normally.
 */
(function () {
  var gradeSel = document.getElementById('st-filter-grade');
  var sectionSel = document.getElementById('st-filter-section');
  var classSel = document.getElementById('st-filter-class');
  if (!gradeSel || !sectionSel || !classSel) return;

  // Snapshot of the full class list from the server-rendered options. This pool
  // is never mutated, so a Grade change can widen/narrow the Class picker freely
  // without a re-fetch.
  var CLASSES = Array.prototype.slice
    .call(classSel.querySelectorAll('option'))
    .filter(function (o) { return o.value !== ''; })
    .map(function (o) {
      return {
        value: o.value,
        label: o.textContent.trim(),
        grade: o.getAttribute('data-grade') || '',
        section: o.getAttribute('data-section') || '',
      };
    });

  function distinct(list, field, labelFn) {
    var seen = {}, out = [];
    list.forEach(function (it) {
      if (!it[field] || seen[it[field]]) return;
      seen[it[field]] = true;
      out.push({ value: it[field], label: labelFn(it[field]) });
    });
    return out;
  }

  // Rebuild a picker from scratch, keeping a still-valid previous choice so a
  // selection that survives the narrowing above it is never silently dropped.
  function fillSelect(selectEl, placeholderLabel, items) {
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
    selectEl.value = items.some(function (it) { return it.value === previous; }) ? previous : '';
  }

  function rebuildSections() {
    var g = gradeSel.value;
    var pool = g ? CLASSES.filter(function (c) { return c.grade === g; }) : CLASSES;
    fillSelect(sectionSel, 'All sections', distinct(pool, 'section', function (s) { return s; }));
  }

  function rebuildClasses() {
    var g = gradeSel.value;
    var s = sectionSel.value;
    fillSelect(classSel, 'All classes', CLASSES.filter(function (c) {
      if (g && c.grade !== g) return false;
      if (s && c.section !== s) return false;
      return true;
    }));
  }

  function rebuildAll() {
    rebuildSections();
    rebuildClasses();
  }

  gradeSel.addEventListener('change', rebuildAll);
  sectionSel.addEventListener('change', rebuildClasses);

  // Initialise from the server-rendered selections so a Grade/Section that came
  // back in the query string (a fresh load, a paginated link, or a reload after
  // "Filter") already shows a narrowed Class list — not just after the user
  // touches the dropdown again.
  rebuildAll();
})();
