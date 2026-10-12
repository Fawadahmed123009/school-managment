// Attendance dashboard — filter toggles, charts, sortable table, banner.
// Externalised so the page carries no inline <script> (CSP script-src 'self').
//
// FILTER TOGGLES ─────────────────────────────────────────────────────────
//   #rangeType → shows/hides .range-field / .range-{today|week|month|custom}
//   #scope     → shows/hides .scope-field / .scope-{class|student}
//                plus the .scope-student-panel (student search sub-form)
//
// DASHBOARD WIDGETS ──────────────────────────────────────────────────────
//   #incompleteBanner     ← dismissible amber warning (per view; reappears
//                            naturally on the next server render / date change)
//   #weeklyTrendChart     ← bar chart, daily attendance RATE for the 7 days
//                            ending at the range end. Colour encodes marking
//                            completeness: green = full, amber = partial,
//                            grey = not marked.
//   #overviewChart        ← doughnut: present / absent / late for the range
//   #classWiseTable       ← click-to-sort column headings
//   #studentSummaryChart  ← student scope, student selected (doughnut)
// Each widget only initialises if its element(s) exist on the page.

document.addEventListener('DOMContentLoaded', function () {

  // ── Filter toggle logic ──────────────────────────────────────────────

  var rangeSelect = document.getElementById('rangeType');
  var scopeSelect = document.getElementById('scope');

  function syncRangeFields() {
    if (!rangeSelect) return;
    var type = rangeSelect.value;
    document.querySelectorAll('.range-field').forEach(function (el) {
      el.style.display = 'none';
    });
    document.querySelectorAll('.range-' + type).forEach(function (el) {
      el.style.display = '';
    });
  }

  function syncScopeFields() {
    if (!scopeSelect) return;
    var scope = scopeSelect.value;

    // Class selector in the main filter bar. Generic naming convention:
    // a field is shown for scope X when it carries the class "scope-X",
    // so the same script serves the admin page (class / student) and the
    // teacher page (specificClass / specificStudent) unchanged.
    document.querySelectorAll('.scope-field').forEach(function (el) {
      el.style.display = el.classList.contains('scope-' + scope) ? '' : 'none';
    });

    // Student search sub-panel (always in DOM, toggled by JS). Targeted by
    // id because the panel class differs between the two pages.
    var studentPanel = document.getElementById('studentSearchPanel');
    if (studentPanel) {
      var isStudentScope = (scope === 'student' || scope === 'specificStudent');
      studentPanel.style.display = isStudentScope ? '' : 'none';
    }
  }

  // Wire up change handlers (replaces inline onchange= blocked by CSP)
  if (rangeSelect) rangeSelect.addEventListener('change', syncRangeFields);
  if (scopeSelect) scopeSelect.addEventListener('change', syncScopeFields);

  // Set initial visibility on page load
  syncRangeFields();
  syncScopeFields();

  // ── Incomplete-marking banner dismissal (hidden for this view only;
  //    any date/scope change re-renders server-side and it reappears) ──
  var banner = document.getElementById('incompleteBanner');
  var bannerClose = document.getElementById('dismissBanner');
  if (banner && bannerClose) {
    bannerClose.addEventListener('click', function () {
      banner.style.display = 'none';
    });
  }

  // ── Sortable class-wise table ────────────────────────────────────────
  var table = document.getElementById('classWiseTable');
  if (table) {
    var headers = table.querySelectorAll('th.th-sort');
    var state = { key: null, dir: 1 };

    headers.forEach(function (th) {
      function doSort() {
        var key = th.getAttribute('data-sort');
        state.dir = (state.key === key) ? -state.dir : 1;
        state.key = key;

        var tbody = table.tBodies[0];
        var rows = Array.prototype.slice.call(tbody.rows);
        rows.sort(function (a, b) {
          var av = a.getAttribute('data-' + key);
          var bv = b.getAttribute('data-' + key);
          if (key === 'name') return av.localeCompare(bv) * state.dir;
          // Numeric columns: empty data-rate (unmarked class) sinks to bottom
          var an = av === '' ? -Infinity : Number(av);
          var bn = bv === '' ? -Infinity : Number(bv);
          return (an - bn) * state.dir;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });

        headers.forEach(function (h) { h.classList.remove('sort-asc', 'sort-desc'); });
        th.classList.add(state.dir === 1 ? 'sort-asc' : 'sort-desc');
      }
      th.addEventListener('click', doSort);
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); }
      });
    });
  }

  // ── Chart rendering ──────────────────────────────────────────────────

  if (typeof Chart === 'undefined') return;

  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#6b7280';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;
  Chart.defaults.elements.bar.borderRadius = 4;

  var PRESENT_COLOR = '#10b981';
  var ABSENT_COLOR  = '#ef4444';
  var LATE_COLOR    = '#f59e0b';
  var PARTIAL_COLOR = '#f59e0b';
  var UNMARKED_COLOR = '#e5e7eb';
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function readJsonIsland(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (e) { return null; }
  }

  // ── 1. Weekly attendance trend (bar chart, daily RATE %) ──
  var weekly = readJsonIsland('weekly-data');
  var weeklyCanvas = document.getElementById('weeklyTrendChart');
  if (weekly && weeklyCanvas) {
    new Chart(weeklyCanvas, {
      type: 'bar',
      data: {
        labels: weekly.map(function (d) {
          var dow = DAY_NAMES[new Date(d.date + 'T00:00:00').getDay()];
          return dow + '\n' + d.date.slice(5);
        }),
        datasets: [{
          label: 'Attendance rate',
          data: weekly.map(function (d) { return d.rate === null ? 0 : d.rate; }),
          backgroundColor: weekly.map(function (d) {
            if (d.unmarked) return UNMARKED_COLOR;
            return d.partial ? PARTIAL_COLOR : PRESENT_COLOR;
          }),
          borderRadius: 6,
          maxBarThickness: 46,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true, max: 100, ticks: { callback: function (v) { return v + '%'; } } },
          x: { grid: { display: false } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var d = weekly[ctx.dataIndex];
                if (d.unmarked) return 'Not marked';
                var rate = d.rate === null ? '—' : d.rate + '%';
                return 'Rate ' + rate + ' · ' + d.marked + ' marked' + (d.partial ? ' (partial)' : '');
              }
            }
          }
        }
      }
    });
  }

  // ── 2. Attendance overview doughnut (present / absent / late) ──
  var overview = readJsonIsland('overview-data');
  var overviewCanvas = document.getElementById('overviewChart');
  if (overview && overviewCanvas && overview.marked > 0) {
    new Chart(overviewCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Present', 'Absent', 'Late'],
        datasets: [{
          data: [overview.present, overview.absent, overview.late],
          backgroundColor: [PRESENT_COLOR, ABSENT_COLOR, LATE_COLOR],
          borderWidth: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: { legend: { position: 'bottom' } }
      }
    });
  }

  // ── 3. Student summary doughnut (student scope, student selected) ──
  var stuSummary = readJsonIsland('student-summary-data');
  var stuCanvas = document.getElementById('studentSummaryChart');
  if (stuSummary && stuCanvas && stuSummary.total > 0) {
    new Chart(stuCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Present', 'Absent', 'Late'],
        datasets: [{
          data: [stuSummary.present, stuSummary.absent, stuSummary.late],
          backgroundColor: [PRESENT_COLOR, ABSENT_COLOR, LATE_COLOR],
          borderWidth: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: { legend: { position: 'bottom' } }
      }
    });
  }
});
