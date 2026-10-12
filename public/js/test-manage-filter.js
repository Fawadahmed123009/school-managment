/**
 * "All tests" ledger tools on the Manage tests page.
 *
 * Session → Phase → Week → Grade → Subject dropdowns narrow the ledger below.
 * Options are built from the rows that are already rendered
 * (data-session / data-phase / data-week / data-grades / data-subject), so no
 * API round-trip is needed and a category only appears when it actually
 * contains tests. Selecting a broader level drops narrower choices that are no
 * longer valid.
 *
 * On top of the cascade:
 *  - "Sort by date" re-orders the matching rows newest/oldest first (the
 *    default keeps the server-rendered session → phase → week grouping).
 *  - The matching rows are paginated client-side (25 / 50 / 100 per page) with
 *    a Prev · numbers · Next bar, page 1 whenever a filter changes.
 */
(function () {
  var tbody = document.getElementById('tests-tbody');
  if (!tbody) return;

  var resetBtn = document.getElementById('filter-reset');
  var countLine = document.getElementById('filter-count');
  var emptyState = document.getElementById('filter-empty');
  var sortSelect = document.getElementById('filter-sort');
  var limitSelect = document.getElementById('filter-limit');
  var pagBar = document.getElementById('filter-pagination');
  var pagInfo = document.getElementById('filter-pagination-info');
  var pagLinks = document.getElementById('filter-pagination-links');

  // Cascade order, broadest first. Every level except grade is single-valued
  // on a row; a test can span several grades, so the grade level ANY-matches
  // the row's data-grades list.
  var LEVELS = ['session', 'phase', 'week', 'grade', 'subject'];
  var ALL_LABELS = {
    session: 'All sessions',
    phase: 'All phases',
    week: 'All weeks',
    grade: 'All grades',
    subject: 'All subjects',
  };

  var selects = {};
  LEVELS.forEach(function (level) {
    selects[level] = document.getElementById('filter-' + level);
  });
  if (!selects.session || !selects.phase || !selects.week) return;

  var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
  var TOTAL = rows.length;
  var DEFAULT_LIMIT = 25;
  var page = 1;

  // PG first, then 1–12 numerically (gradeLevel is stored as a string).
  var GRADE_ORDER = ['PG', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

  function gradeRank(g) {
    var i = GRADE_ORDER.indexOf(String(g));
    return i === -1 ? GRADE_ORDER.length : i;
  }

  function keyOf(row, category) {
    return row.getAttribute('data-' + category) || 'none';
  }

  function labelOf(row, category) {
    return row.getAttribute('data-' + category + '-name') || '—';
  }

  function gradesOf(row) {
    var raw = row.getAttribute('data-grades') || '';
    var list = raw ? raw.split(',') : [];
    return list.length ? list : ['none'];
  }

  function gradeLabel(g) {
    return g === 'none' ? 'No grade' : 'Grade ' + g;
  }

  function rowMatches(row, level, value) {
    if (!value) return true;
    if (level === 'grade') return gradesOf(row).indexOf(value) !== -1;
    return keyOf(row, level) === value;
  }

  /** Rows matching every active choice in `levels` (array of level names). */
  function rowsMatching(levels) {
    return rows.filter(function (row) {
      for (var i = 0; i < levels.length; i++) {
        if (!rowMatches(row, levels[i], selects[levels[i]].value)) return false;
      }
      return true;
    });
  }

  /** Distinct single-valued categories of a row set, in ledger order. */
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

  /** Distinct grades of a row set (a row contributes each grade it spans). */
  function collectGrades(rowSet) {
    var seen = {};
    var items = [];

    rowSet.forEach(function (row) {
      gradesOf(row).forEach(function (g) {
        if (seen[g]) return;
        seen[g] = true;
        items.push({ value: g, label: gradeLabel(g) });
      });
    });

    items.sort(function (a, b) { return gradeRank(a.value) - gradeRank(b.value); });
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

    // A choice that no longer exists (e.g. a week from another phase) is
    // dropped; with a single remaining category the "all" view says the same.
    var stillValid = items.some(function (item) { return item.value === previous; });
    selectEl.value = stillValid && items.length > 1 ? previous : '';
    selectEl.disabled = items.length === 0;
  }

  /** Refill one cascade level from the rows its upstream choices narrow to. */
  function fillLevel(levelIndex) {
    var level = LEVELS[levelIndex];
    var upstream = LEVELS.slice(0, levelIndex);
    var rowSet = rowsMatching(upstream);
    var items = level === 'grade' ? collectGrades(rowSet) : collect(rowSet, level);

    if (level === 'subject') {
      items.sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
    }
    fillSelect(selects[level], ALL_LABELS[level], items);
  }

  function rebuildAll() {
    for (var i = 0; i < LEVELS.length; i++) fillLevel(i);
  }

  function perPageSize() {
    return limitSelect ? (parseInt(limitSelect.value, 10) || DEFAULT_LIMIT) : DEFAULT_LIMIT;
  }

  function renderPagination(matched, pages) {
    if (!pagBar || !pagInfo || !pagLinks) return;

    if (pages <= 1) {
      pagBar.style.display = 'none';
      return;
    }
    pagBar.style.display = '';

    pagInfo.textContent =
      'Page ' + page + ' of ' + pages + ' · ' + matched + ' test' + (matched === 1 ? '' : 's') + ' matching';

    pagLinks.innerHTML = '';

    function addLink(label, target, opts) {
      opts = opts || {};
      if (opts.active) {
        var span = document.createElement('span');
        span.className = 'page-link active';
        span.textContent = label;
        pagLinks.appendChild(span);
        return;
      }
      var el;
      if (opts.disabled) {
        el = document.createElement('span');
        el.className = 'page-link disabled';
        el.textContent = label;
      } else {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'page-link';
        el.textContent = label;
        el.addEventListener('click', function () {
          page = target;
          apply();
        });
      }
      pagLinks.appendChild(el);
    }

    function addEllipsis() {
      var span = document.createElement('span');
      span.className = 'page-ellipsis';
      span.textContent = '\u2026';
      pagLinks.appendChild(span);
    }

    addLink('« Prev', page - 1, { disabled: page <= 1 });

    // Page numbers with ellipsis for large page counts (same windowing as the
    // marks-audit ledger).
    var pageList = [1];
    for (var p = Math.max(2, page - 2); p <= Math.min(pages - 1, page + 2); p++) pageList.push(p);
    pageList.push(pages);
    var prevPage = 0;
    pageList.forEach(function (v) {
      if (v - prevPage > 1) addEllipsis();
      addLink(String(v), v, { active: v === page, disabled: false });
      prevPage = v;
    });

    addLink('Next »', page + 1, { disabled: page >= pages });
  }

  function apply() {
    var matched = rowsMatching(LEVELS);

    // Order: the chosen date sort moves matching rows (sorted) to the end of
    // the tbody; otherwise the server-rendered grouping is restored.
    rows.forEach(function (row) { tbody.appendChild(row); });
    var mode = sortSelect ? sortSelect.value : '';
    if (mode) {
      var dir = mode === 'date-asc' ? 1 : -1;
      matched = matched.slice().sort(function (a, b) {
        return dir * (Number(a.getAttribute('data-date') || 0) - Number(b.getAttribute('data-date') || 0));
      });
      matched.forEach(function (row) { tbody.appendChild(row); });
    }

    // Paginate the matched slice; every other row stays hidden.
    var limit = perPageSize();
    var pages = Math.max(1, Math.ceil(matched.length / limit));
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    var start = (page - 1) * limit;

    rows.forEach(function (row) { row.style.display = 'none'; });
    matched.forEach(function (row, i) {
      row.style.display = i >= start && i < start + limit ? '' : 'none';
    });

    var filtered = LEVELS.some(function (level) { return selects[level].value; });

    if (countLine) {
      countLine.textContent = filtered
        ? 'Showing ' + matched.length + ' of ' + TOTAL + ' tests.'
        : TOTAL + ' tests grouped by session, then phase, then week.';
    }
    if (emptyState) emptyState.style.display = matched.length === 0 ? '' : 'none';
    if (resetBtn) resetBtn.style.display = filtered ? '' : 'none';

    renderPagination(matched.length, pages);
  }

  LEVELS.forEach(function (level, index) {
    selects[level].addEventListener('change', function () {
      // Downstream lists narrow to the new choice; invalid deeper selections
      // are dropped by fillSelect.
      for (var j = index + 1; j < LEVELS.length; j++) fillLevel(j);
      page = 1;
      apply();
    });
  });

  if (sortSelect) {
    sortSelect.addEventListener('change', function () {
      page = 1;
      apply();
    });
  }

  if (limitSelect) {
    limitSelect.addEventListener('change', function () {
      page = 1;
      apply();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      LEVELS.forEach(function (level) { selects[level].value = ''; });
      rebuildAll();
      page = 1;
      apply();
    });
  }

  rebuildAll();
  apply();
})();
