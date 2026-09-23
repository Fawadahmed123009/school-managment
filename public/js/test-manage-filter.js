/**
 * "All tests" category cascade on the Manage tests page.
 *
 * Session → Phase → Week dropdowns narrow the ledger below. Options are built
 * from the rows that are already rendered (data-session / data-phase /
 * data-week), so no API round-trip is needed and a category only appears when
 * it actually contains tests.
 */
(function () {
  var tbody = document.getElementById('tests-tbody');
  var sessionSelect = document.getElementById('filter-session');
  var phaseSelect = document.getElementById('filter-phase');
  var weekSelect = document.getElementById('filter-week');
  var resetBtn = document.getElementById('filter-reset');
  var countLine = document.getElementById('filter-count');
  var emptyState = document.getElementById('filter-empty');

  if (!tbody || !sessionSelect || !phaseSelect || !weekSelect) return;

  var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
  var TOTAL = rows.length;

  function keyOf(row, category) {
    return row.getAttribute('data-' + category) || 'none';
  }

  function labelOf(row, category) {
    return row.getAttribute('data-' + category + '-name') || '—';
  }

  /** Rows matching the current session (+ phase when given). */
  function matchingRows(withPhase) {
    var sessionId = sessionSelect.value;
    var phaseId = phaseSelect.value;

    return rows.filter(function (row) {
      if (sessionId && keyOf(row, 'session') !== sessionId) return false;
      if (withPhase && phaseId && keyOf(row, 'phase') !== phaseId) return false;
      return true;
    });
  }

  /** Distinct categories of a row set, in ledger order, as {value,label}. */
  function collect(rowSet, category) {
    var seen = {};
    var items = [];

    rowSet.forEach(function (row) {
      var value = keyOf(row, category);
      if (seen[value]) return;
      seen[value] = true;
      items.push({ value: value, label: labelOf(row, category) });
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

    // A choice that no longer exists (e.g. a phase from another session) is
    // dropped; with a single remaining category the "all" view says the same.
    var stillValid = items.some(function (item) { return item.value === previous; });
    selectEl.value = stillValid && items.length > 1 ? previous : '';
    selectEl.disabled = items.length === 0;
  }

  function applyFilter() {
    var sessionId = sessionSelect.value;
    var phaseId = phaseSelect.value;
    var weekId = weekSelect.value;
    var shown = 0;

    rows.forEach(function (row) {
      var match =
        (!sessionId || keyOf(row, 'session') === sessionId) &&
        (!phaseId || keyOf(row, 'phase') === phaseId) &&
        (!weekId || keyOf(row, 'week') === weekId);

      row.style.display = match ? '' : 'none';
      if (match) shown++;
    });

    var filtered = sessionId || phaseId || weekId;

    if (countLine) {
      countLine.textContent = filtered
        ? 'Showing ' + shown + ' of ' + TOTAL + ' tests.'
        : TOTAL + ' tests grouped by session, then phase, then week.';
    }
    if (emptyState) emptyState.style.display = shown === 0 ? '' : 'none';
    if (resetBtn) resetBtn.style.display = filtered ? '' : 'none';
  }

  function rebuildWeeks() {
    fillSelect(weekSelect, 'All weeks', collect(matchingRows(true), 'week'));
  }

  function rebuildPhases() {
    fillSelect(phaseSelect, 'All phases', collect(matchingRows(false), 'phase'));
    rebuildWeeks();
  }

  function rebuildAll() {
    fillSelect(sessionSelect, 'All sessions', collect(rows, 'session'));
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

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      sessionSelect.value = '';
      rebuildAll();
    });
  }

  rebuildAll();
})();
