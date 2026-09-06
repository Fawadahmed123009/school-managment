// Test analytics charts — distribution histogram + comparison grouped bar.
// Data arrives via a CSP-safe JSON island: <script type="application/json" id="analytics-chart-data">.
document.addEventListener('DOMContentLoaded', function () {
  if (typeof Chart === 'undefined') return;

  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#6b7280';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;
  Chart.defaults.elements.bar.borderRadius = 4;

  var dataEl = document.getElementById('analytics-chart-data');
  if (!dataEl) return;
  var payload = JSON.parse(dataEl.textContent);
  var distribution = payload.distribution || [];
  var current = payload.current;
  var previous = payload.previous;

  // ── Distribution histogram ────────────────────────────────
  var distCanvas = document.getElementById('distributionChart');
  if (distCanvas && distribution.length > 0) {
    new Chart(distCanvas, {
      type: 'bar',
      data: {
        labels: distribution.map(function (d) { return d.label; }),
        datasets: [{
          label: 'Students',
          data: distribution.map(function (d) { return d.count; }),
          backgroundColor: 'rgba(59, 130, 246, 0.65)',
          borderColor: '#3b82f6',
          borderWidth: 1,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              stepSize: 1,
              callback: function (v) { return v; }
            },
            title: { display: true, text: 'Number of students' }
          },
          x: {
            title: { display: true, text: 'Mark range' },
            grid: { display: false }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { return 'Range: ' + items[0].label; },
              label: function (ctx) {
                return ctx.parsed.y + ' student' + (ctx.parsed.y === 1 ? '' : 's');
              }
            }
          }
        }
      }
    });
  }

  // ── Comparison grouped bar chart ──────────────────────────
  var compCanvas = document.getElementById('comparisonChart');
  if (compCanvas && current && previous && previous.count > 0) {
    var categories = ['Average', 'Highest', 'Lowest', 'Std deviation'];
    var currentValues = [current.avg, current.max, current.min, current.stddev];
    var previousValues = [previous.avg, previous.max, previous.min, previous.stddev];

    new Chart(compCanvas, {
      type: 'bar',
      data: {
        labels: categories,
        datasets: [
          {
            label: current.testName || 'Current',
            data: currentValues,
            backgroundColor: 'rgba(59, 130, 246, 0.7)',
            borderColor: '#3b82f6',
            borderWidth: 1,
          },
          {
            label: previous.testName || 'Previous',
            data: previousValues,
            backgroundColor: 'rgba(107, 114, 128, 0.45)',
            borderColor: '#9ca3af',
            borderWidth: 1,
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Marks' }
          },
          x: { grid: { display: false } }
        },
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                return ctx.dataset.label + ': ' + ctx.parsed.y;
              }
            }
          }
        }
      }
    });
  }
});
