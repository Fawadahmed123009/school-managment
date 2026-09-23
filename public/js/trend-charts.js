// Trend analytics charts — student score trend (multi-line) + class average trend.
// Data arrives via a CSP-safe JSON island: <script type="application/json" id="trend-chart-data">.
document.addEventListener('DOMContentLoaded', function () {
  if (typeof Chart === 'undefined') return;

  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#6b7280';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;

  var dataEl = document.getElementById('trend-chart-data');
  if (!dataEl) return;
  var payload = JSON.parse(dataEl.textContent);
  var trendMode = payload.trendMode;
  var trendLines = payload.trendLines || [];
  var trendTableRows = payload.trendTableRows || [];

  var canvas = document.getElementById('trendChart');
  if (!canvas) return;

  var palette = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6',
    '#f97316', '#6366f1', '#84cc16', '#e11d48',
  ];

  if (trendMode === 'class') {
    // ── Class trend: one average-% line per class/section ────
    // trendLines = [{ className, points:[{ testName, date, avgPercent, minPercent, maxPercent }] }]
    if (trendLines.length === 0) return;

    // Shared x-axis: every distinct test (name + date) across all class lines.
    var allDates = {};
    trendLines.forEach(function (line) {
      line.points.forEach(function (p) {
        var key = new Date(p.date).getTime() + '|' + p.testName;
        if (!allDates[key]) allDates[key] = { date: p.date, testName: p.testName };
      });
    });
    var sortedDates = Object.keys(allDates).sort(function (a, b) {
      return new Date(allDates[a].date) - new Date(allDates[b].date);
    });
    var labels = sortedDates.map(function (k) {
      var d = allDates[k];
      return d.testName + ' (' + new Date(d.date).toLocaleDateString() + ')';
    });

    var datasets = [];
    trendLines.forEach(function (line, i) {
      // Map this class's points onto the global label axis.
      var avgMap = {}, minMap = {}, maxMap = {};
      line.points.forEach(function (p) {
        var key = new Date(p.date).getTime() + '|' + p.testName;
        var idx = sortedDates.indexOf(key);
        if (idx < 0) return;
        avgMap[idx] = p.avgPercent;
        minMap[idx] = p.minPercent;
        maxMap[idx] = p.maxPercent;
      });
      var pick = function (m) {
        return sortedDates.map(function (_, idx) { return m[idx] !== undefined ? m[idx] : null; });
      };
      var color = palette[i % palette.length];
      datasets.push({
        label: line.className,
        data: pick(avgMap),
        borderColor: color,
        backgroundColor: color + '14',
        fill: false,
        tension: 0.35,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2.5,
        spanGaps: false,
      });
      // With a single class, keep the richer min/max band view.
      if (trendLines.length === 1) {
        datasets.push({
          label: 'Min %',
          data: pick(minMap),
          borderColor: 'rgba(239, 68, 68, 0.5)',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.35,
        });
        datasets.push({
          label: 'Max %',
          data: pick(maxMap),
          borderColor: 'rgba(16, 185, 129, 0.5)',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0.35,
        });
      }
    });

    new Chart(canvas, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            ticks: { callback: function (v) { return v + '%'; } },
            title: { display: true, text: 'Average percentage' },
          },
          x: { grid: { display: false } },
        },
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                if (ctx.parsed.y === null) return ctx.dataset.label + ': —';
                return ctx.dataset.label + ': ' + ctx.parsed.y + '%';
              }
            }
          }
        }
      }
    });

  } else {
    // ── Student trend (one line per subject) ─────────────────
    if (trendLines.length === 0) return;

    // Collect all unique test dates for the x-axis
    var allDates = {};
    trendLines.forEach(function (line) {
      line.points.forEach(function (p) {
        var key = new Date(p.date).getTime() + '|' + p.testName;
        if (!allDates[key]) allDates[key] = { date: p.date, testName: p.testName };
      });
    });
    var sortedDates = Object.keys(allDates).sort(function (a, b) {
      return new Date(allDates[a].date) - new Date(allDates[b].date);
    });
    var labels = sortedDates.map(function (k) {
      var d = allDates[k];
      return d.testName + ' (' + new Date(d.date).toLocaleDateString() + ')';
    });

    var datasets = trendLines.map(function (line, i) {
      var color = palette[i % palette.length];
      // Map points to the global label axis
      var dataMap = {};
      line.points.forEach(function (p) {
        var key = new Date(p.date).getTime() + '|' + p.testName;
        var idx = sortedDates.indexOf(key);
        if (idx >= 0 && p.percent !== null) dataMap[idx] = p.percent;
      });
      var data = sortedDates.map(function (_, idx) {
        return dataMap[idx] !== undefined ? dataMap[idx] : null;
      });

      return {
        label: line.subject,
        data: data,
        borderColor: color,
        backgroundColor: color + '14',
        fill: false,
        tension: 0.35,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2,
        spanGaps: false,
      };
    });

    new Chart(canvas, {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            max: 100,
            ticks: { callback: function (v) { return v + '%'; } },
            title: { display: true, text: 'Score percentage' },
          },
          x: { grid: { display: false } },
        },
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                if (ctx.parsed.y === null) return ctx.dataset.label + ': —';
                return ctx.dataset.label + ': ' + ctx.parsed.y + '%';
              }
            }
          }
        }
      }
    });
  }
});
