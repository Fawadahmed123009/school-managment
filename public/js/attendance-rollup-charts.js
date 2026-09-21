// Attendance rollup — filter toggles + adaptive charts.
// Externalised so the page carries no inline <script> (CSP script-src 'self').
//
// FILTER TOGGLES ─────────────────────────────────────────────────────────
// Two <select> elements control which date/scope fields are visible:
//   #rangeType → shows/hides .range-field / .range-{today|week|month|custom}
//   #scope     → shows/hides .scope-field / .scope-{class|student}
//                plus the .scope-student-panel (student search sub-form)
//
// CHART RENDERING ────────────────────────────────────────────────────────
// Adaptive rendering based on which data islands and canvases are present:
//   #snapshotChart        ← single-day, institute or class scope (doughnut)
//   #dailyAttChart        ← multi-day, institute or class scope (line)
//   #classAttChart        ← multi-day, institute scope only (bar)
//   #studentSummaryChart  ← student scope, student selected (doughnut)
// Each chart only renders if BOTH its canvas AND its data island exist.

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

    // Class selector in the main filter bar
    document.querySelectorAll('.scope-field').forEach(function (el) {
      el.style.display = 'none';
    });
    if (scope === 'class') {
      document.querySelectorAll('.scope-class').forEach(function (el) {
        el.style.display = '';
      });
    } else if (scope === 'student') {
      document.querySelectorAll('.scope-student').forEach(function (el) {
        el.style.display = '';
      });
    }

    // Student search sub-panel (always in DOM, toggled by JS)
    var studentPanel = document.querySelector('.scope-student-panel');
    if (studentPanel) {
      studentPanel.style.display = (scope === 'student') ? '' : 'none';
    }
  }

  // Wire up change handlers (replaces inline onchange= blocked by CSP)
  if (rangeSelect) rangeSelect.addEventListener('change', syncRangeFields);
  if (scopeSelect) scopeSelect.addEventListener('change', syncScopeFields);

  // Set initial visibility on page load
  syncRangeFields();
  syncScopeFields();

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

  // ── 1. Snapshot doughnut (single day, institute/class scope) ──
  var snapDataEl  = document.getElementById('snapshot-data');
  var snapCanvas  = document.getElementById('snapshotChart');
  if (snapDataEl && snapCanvas) {
    var snap;
    try { snap = JSON.parse(snapDataEl.textContent); } catch (e) { snap = null; }
    if (snap && snap.total > 0) {
      new Chart(snapCanvas, {
        type: 'doughnut',
        data: {
          labels: ['Present', 'Absent', 'Late'],
          datasets: [{
            data: [snap.present, snap.absent, snap.late],
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
  }

  // ── 2. Daily trend line chart (multi-day, institute/class scope) ──
  var dailyDataEl = document.getElementById('daily-rollup-data');
  var dailyCanvas = document.getElementById('dailyAttChart');
  if (dailyDataEl && dailyCanvas) {
    var dailyRollup;
    try { dailyRollup = JSON.parse(dailyDataEl.textContent); } catch (e) { dailyRollup = null; }
    if (dailyRollup && dailyRollup.length > 0) {
      new Chart(dailyCanvas, {
        type: 'line',
        data: {
          labels: dailyRollup.map(function (d) { return d.date; }),
          datasets: [
            {
              label: 'Present',
              data: dailyRollup.map(function (d) { return d.present; }),
              borderColor: PRESENT_COLOR,
              backgroundColor: 'transparent',
              tension: 0.3,
              pointRadius: 2,
              borderWidth: 2,
            },
            {
              label: 'Absent',
              data: dailyRollup.map(function (d) { return d.absent; }),
              borderColor: ABSENT_COLOR,
              backgroundColor: 'transparent',
              tension: 0.3,
              pointRadius: 2,
              borderWidth: 2,
            },
            {
              label: 'Late',
              data: dailyRollup.map(function (d) { return d.late; }),
              borderColor: LATE_COLOR,
              backgroundColor: 'transparent',
              tension: 0.3,
              pointRadius: 2,
              borderWidth: 2,
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, ticks: { precision: 0 } },
            x: { grid: { display: false } }
          },
          plugins: { legend: { display: true } }
        }
      });
    }
  }

  // ── 3. Per-class comparison bar chart (multi-day, institute scope) ──
  var classDataEl = document.getElementById('class-rollup-data');
  var classCanvas = document.getElementById('classAttChart');
  if (classDataEl && classCanvas) {
    var rollup;
    try { rollup = JSON.parse(classDataEl.textContent); } catch (e) { rollup = null; }
    if (rollup) {
      var classNames = Object.keys(rollup);
      if (classNames.length > 0) {
        new Chart(classCanvas, {
          type: 'bar',
          data: {
            labels: classNames,
            datasets: [
              { label: 'Present', data: classNames.map(function (c) { return rollup[c].present; }), backgroundColor: PRESENT_COLOR },
              { label: 'Absent',  data: classNames.map(function (c) { return rollup[c].absent; }),  backgroundColor: ABSENT_COLOR },
              { label: 'Late',    data: classNames.map(function (c) { return rollup[c].late; }),    backgroundColor: LATE_COLOR },
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
              y: { beginAtZero: true, ticks: { precision: 0 } },
              x: { grid: { display: false } }
            },
            plugins: { legend: { display: true } }
          }
        });
      }
    }
  }

  // ── 4. Student summary doughnut (student scope, student selected) ──
  var stuDataEl = document.getElementById('student-summary-data');
  var stuCanvas = document.getElementById('studentSummaryChart');
  if (stuDataEl && stuCanvas) {
    var stuSummary;
    try { stuSummary = JSON.parse(stuDataEl.textContent); } catch (e) { stuSummary = null; }
    if (stuSummary && stuSummary.total > 0) {
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
  }
});
