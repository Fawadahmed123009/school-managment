/**
 * Result-sheet category cascade on the PDF report form.
 *
 * Session → Phase → Week narrow the list of pickable tests. The three selects
 * are pure filter controls — they carry no `name`, so only testId is ever
 * submitted — and their options are built from the test options that actually
 * exist on the page, so a category only appears when it holds tests. This
 * mirrors the Manage tests ledger cascade (test-manage-filter.js), except that
 * the narrowing happens inside the submitted dropdown instead of on table rows.
 */
(function () {
  var testSelect = document.getElementById('testId_rs');
  var sessionSelect = document.getElementById('rs-session');
  var phaseSelect = document.getElementById('rs-phase');
  var weekSelect = document.getElementById('rs-week');
  var countLine = document.getElementById('rs-test-count');

  if (!testSelect || !sessionSelect || !phaseSelect || !weekSelect) return;

  var placeholder = testSelect.querySelector('option[value=""]');

  // Snapshot the rendered options; the list is rebuilt from this copy so a
  // filtered-out test can be restored when the filters are loosened again.
  var ALL = Array.prototype.slice
    .call(testSelect.querySelectorAll('option'))
    .filter(function (option) { return option.value !== ''; })
    .map(function (option) {
      return {
        value: option.value,
        label: option.textContent.trim(),
        session: option.getAttribute('data-session'),
        sessionName: option.getAttribute('data-session-name'),
        phase: option.getAttribute('data-phase'),
        phaseName: option.getAttribute('data-phase-name'),
        week: option.getAttribute('data-week'),
        weekName: option.getAttribute('data-week-name'),
      };
    });

  var TOTAL = ALL.length;

  /** Tests surviving the filters strictly above `level`. */
  function matching(level) {
    return ALL.filter(function (test) {
      if (level !== 'session' && sessionSelect.value && test.session !== sessionSelect.value) return false;
      if (level === 'test' || level === 'week') {
        if (phaseSelect.value && test.phase !== phaseSelect.value) return false;
      }
      if (level === 'test' && weekSelect.value && test.week !== weekSelect.value) return false;
      return true;
    });
  }

  /** Distinct categories of a test set, in page order, as {value,label}. */
  function collect(testSet, category) {
    var seen = {};
    var items = [];

    testSet.forEach(function (test) {
      var value = test[category];
      if (seen[value]) return;
      seen[value] = true;
      items.push({ value: value, label: test[category + 'Name'] });
    });

    return items;
  }

  /** Refill a dropdown, keeping the current choice when it is still valid. */
  function fillSelect(selectEl, allLabel, items) {
    var previous = selectEl.value;

    selectEl.innerHTML = '';

    var allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = allLabel;
    selectEl.appendChild(allOption);

    items.forEach(function (item) {
      var opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      selectEl.appendChild(opt);
    });

    // A choice that no longer exists (e.g. a phase of another session) is
    // dropped; with a single remaining category the "all" view says the same.
    var stillValid = items.some(function (item) { return item.value === previous; });
    selectEl.value = stillValid && items.length > 1 ? previous : '';
    selectEl.disabled = items.length === 0;
  }

  function applyFilter() {
    var shown = matching('test');
    var previous = testSelect.value;

    testSelect.innerHTML = '';
    if (placeholder) testSelect.appendChild(placeholder);
    shown.forEach(function (test) {
      var opt = document.createElement('option');
      opt.value = test.value;
      opt.textContent = test.label;
      testSelect.appendChild(opt);
    });

    // A test the new filters exclude is dropped rather than submitted.
    testSelect.value = shown.some(function (test) { return test.value === previous; }) ? previous : '';

    if (countLine) {
      var filtered = sessionSelect.value || phaseSelect.value || weekSelect.value;
      countLine.textContent = filtered
        ? 'Showing ' + shown.length + ' of ' + TOTAL + ' tests.'
        : TOTAL + ' tests grouped by session, then phase, then week.';
    }
  }

  function rebuildWeeks() {
    fillSelect(weekSelect, 'All weeks', collect(matching('week'), 'week'));
  }

  function rebuildPhases() {
    fillSelect(phaseSelect, 'All phases', collect(matching('phase'), 'phase'));
    rebuildWeeks();
  }

  function rebuildAll() {
    fillSelect(sessionSelect, 'All sessions', collect(ALL, 'session'));
    rebuildPhases();
    applyFilter();
  }

  sessionSelect.addEventListener('change', function () {
    rebuildPhases();
    applyFilter();
  });

  phaseSelect.addEventListener('change', function () {
    rebuildWeeks();
    applyFilter();
  });

  weekSelect.addEventListener('change', applyFilter);

  rebuildAll();
})();
