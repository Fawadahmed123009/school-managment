// Student / child analysis charts.
// Externalized so the analysis pages carry no inline <script> (CSP script-src
// has no 'unsafe-inline'). Per-request data (the progress series + subject
// averages the service computes) arrives via a non-executed JSON island written
// by the template: <script type="application/json" id="analysis-data">. Chart.js
// itself is loaded from the CDN tag immediately before this file.
document.addEventListener('DOMContentLoaded', function () {
  if (typeof Chart === 'undefined') return;

  // ── Chart.js defaults (match the dashboard look) ──
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#6b7280';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;
  Chart.defaults.elements.bar.borderRadius = 4;

  var dataEl = document.getElementById('analysis-data');
  var payload = dataEl ? JSON.parse(dataEl.textContent) : {};
  var progress = payload.progress || [];
  var bySubject = payload.bySubject || [];

  // ── Test progress across sessions (line chart) ──
  var progCanvas = document.getElementById('progressChart');
  var progEmpty = document.getElementById('progressEmpty');
  if (progCanvas) {
    if (progress.length > 0) {
      new Chart(progCanvas, {
        type: 'line',
        data: {
          labels: progress.map(function (d) { return d.session; }),
          datasets: [{
            label: 'Average score (%)',
            data: progress.map(function (d) { return d.average; }),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.08)',
            fill: true,
            tension: 0.35,
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2,
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
                label: function (ctx) { return ctx.parsed.y + '% average'; }
              }
            }
          }
        }
      });
    } else {
      progCanvas.style.display = 'none';
      if (progEmpty) progEmpty.style.display = 'flex';
    }
  }

  // ── Subject-wise performance (horizontal bar chart, avg % per subject) ──
  var subjCanvas = document.getElementById('subjectChart');
  var subjEmpty = document.getElementById('subjectEmpty');
  if (subjCanvas) {
    if (bySubject.length > 0) {
      var palette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6'];
      new Chart(subjCanvas, {
        type: 'bar',
        data: {
          labels: bySubject.map(function (d) { return d.subject; }),
          datasets: [{
            label: 'Average (%)',
            data: bySubject.map(function (d) { return d.average; }),
            backgroundColor: bySubject.map(function (d, i) { return palette[i % palette.length]; }),
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { beginAtZero: true, max: 100, ticks: { callback: function (v) { return v + '%'; } } },
            y: { grid: { display: false } }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  var d = bySubject[ctx.dataIndex];
                  return d.average + '% avg over ' + d.count + ' test' + (d.count === 1 ? '' : 's');
                }
              }
            }
          }
        }
      });
    } else {
      subjCanvas.style.display = 'none';
      if (subjEmpty) subjEmpty.style.display = 'flex';
    }
  }
});
