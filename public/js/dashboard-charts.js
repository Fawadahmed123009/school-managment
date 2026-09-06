// Dashboard charts + stat-counter animation.
// Externalized from views/dashboard.ejs so the page carries no inline <script>
// (CSP script-src no longer needs 'unsafe-inline'). Per-request data (chart
// series + the viewer's role) arrives via a non-executed JSON island written by
// the template: <script type="application/json" id="dashboard-data">. Chart.js
// itself is loaded from the CDN tag immediately before this file.
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.stat-value[data-count]').forEach(function(el) {
    var target = parseInt(el.dataset.count, 10);
    if (isNaN(target) || target === 0) return;
    var duration = 800;
    var start = 0;
    var startTime = null;
    function step(ts) {
      if (!startTime) startTime = ts;
      var progress = Math.min((ts - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.floor(ease * target);
      if (progress < 1) requestAnimationFrame(step);
      else el.textContent = target;
    }
    requestAnimationFrame(step);
  });

  // ── Chart.js defaults ──
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#6b7280';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;
  Chart.defaults.elements.bar.borderRadius = 4;

  var dataEl = document.getElementById('dashboard-data');
  var payload = dataEl ? JSON.parse(dataEl.textContent) : {};
  var chartData = payload.charts || {};
  var role = payload.role || '';

  // ── Admin / Teacher: Attendance trend (line chart) ──
  if (role === 'admin' || role === 'teacher') {
    var attCanvas = document.getElementById('attendanceChart');
    var attEmpty = document.getElementById('attendanceEmpty');
    if (chartData.attendanceTrend && chartData.attendanceTrend.length > 0) {
      var labels = chartData.attendanceTrend.map(function(d) {
        var parts = d.date.split('-');
        return parts[1] + '/' + parts[2];
      });
      new Chart(attCanvas, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: 'Attendance rate (%)',
            data: chartData.attendanceTrend.map(function(d) { return d.rate; }),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.08)',
            fill: true,
            tension: 0.35,
            pointRadius: 3,
            pointHoverRadius: 6,
            borderWidth: 2,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, max: 100, ticks: { callback: function(v) { return v + '%'; } } },
            x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: function(ctx) { return ctx.parsed.y + '% attendance'; }
              }
            }
          }
        }
      });
    } else {
      attCanvas.style.display = 'none';
      attEmpty.style.display = 'flex';
    }

    // ── Admin-only: Fee collection (bar chart) ──
    if (role === 'admin') {
      var feeCanvas = document.getElementById('feeCollectionChart');
      var feeEmpty = document.getElementById('feeEmpty');
    if (chartData.feeCollection && chartData.feeCollection.length > 0) {
      var feeLabels = chartData.feeCollection.map(function(d) {
        var parts = d.month.split('-');
        var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return monthNames[parseInt(parts[1], 10) - 1] + ' ' + parts[0].slice(2);
      });
      new Chart(feeCanvas, {
        type: 'bar',
        data: {
          labels: feeLabels,
          datasets: [
            {
              label: 'Collected',
              data: chartData.feeCollection.map(function(d) { return d.collected; }),
              backgroundColor: '#10b981',
            },
            {
              label: 'Outstanding',
              data: chartData.feeCollection.map(function(d) { return d.outstanding; }),
              backgroundColor: '#ef4444',
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: { beginAtZero: true, ticks: { callback: function(v) { return 'Rs ' + (v >= 1000 ? (v/1000).toFixed(0) + 'k' : v); } } },
            x: { grid: { display: false } }
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: function(ctx) { return ctx.dataset.label + ': Rs ' + ctx.parsed.y.toLocaleString(); }
              }
            }
          }
        }
      });
    } else {
      feeCanvas.style.display = 'none';
      feeEmpty.style.display = 'flex';
    }
    }

    // ── Admin-only: Fee breakdown by type (horizontal bar) ──
    if (role === 'admin') {
      var breakdownCanvas = document.getElementById('feeBreakdownChart');
      var breakdownEmpty = document.getElementById('breakdownEmpty');
    if (chartData.feeBreakdown && chartData.feeBreakdown.length > 0) {
      var colors = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4'];
      new Chart(breakdownCanvas, {
        type: 'bar',
        data: {
          labels: chartData.feeBreakdown.map(function(d) { return d.type.charAt(0).toUpperCase() + d.type.slice(1); }),
          datasets: [
            {
              label: 'Paid',
              data: chartData.feeBreakdown.map(function(d) { return d.paid; }),
              backgroundColor: '#10b981',
            },
            {
              label: 'Unpaid',
              data: chartData.feeBreakdown.map(function(d) { return d.total - d.paid; }),
              backgroundColor: '#e5e7eb',
            }
          ]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { stacked: true, ticks: { callback: function(v) { return 'Rs ' + (v >= 1000 ? (v/1000).toFixed(0) + 'k' : v); } } },
            y: { stacked: true, grid: { display: false } }
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: function(ctx) { return ctx.dataset.label + ': Rs ' + ctx.parsed.x.toLocaleString(); }
              }
            }
          }
        }
      });
    } else {
      breakdownCanvas.style.display = 'none';
      breakdownEmpty.style.display = 'flex';
    }
    }
  }

  // ── Student charts ──
  if (role === 'student') {
    // Student attendance (bar chart with color-coded status)
    var sAttCanvas = document.getElementById('studentAttChart');
    var sAttEmpty = document.getElementById('studentAttEmpty');
    if (chartData.attendanceTrend && chartData.attendanceTrend.length > 0) {
      var statusColors = { present: '#10b981', absent: '#ef4444', late: '#f59e0b' };
      new Chart(sAttCanvas, {
        type: 'bar',
        data: {
          labels: chartData.attendanceTrend.map(function(d) {
            var parts = d.date.split('-');
            return parts[1] + '/' + parts[2];
          }),
          datasets: [{
            label: 'Status',
            data: chartData.attendanceTrend.map(function(d) {
              return d.status === 'present' ? 1 : d.status === 'late' ? 0.6 : 0;
            }),
            backgroundColor: chartData.attendanceTrend.map(function(d) { return statusColors[d.status]; }),
            borderRadius: 3,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            y: {
              beginAtZero: true, max: 1.2,
              ticks: {
                stepSize: 0.3,
                callback: function(v) {
                  if (v >= 0.8) return 'Present';
                  if (v >= 0.4) return 'Late';
                  if (v > 0) return 'Absent';
                  return '';
                }
              }
            },
            x: { grid: { display: false }, ticks: { maxTicksLimit: 15 } }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function(ctx) {
                  var raw = chartData.attendanceTrend[ctx.dataIndex];
                  return raw.status.charAt(0).toUpperCase() + raw.status.slice(1);
                }
              }
            }
          }
        }
      });
    } else {
      sAttCanvas.style.display = 'none';
      sAttEmpty.style.display = 'flex';
    }

    // Student fee doughnut
    var sFeeCanvas = document.getElementById('studentFeeChart');
    if (chartData.feeBreakdown && chartData.feeBreakdown.length > 0) {
      new Chart(sFeeCanvas, {
        type: 'doughnut',
        data: {
          labels: chartData.feeBreakdown.map(function(d) { return d.label; }),
          datasets: [{
            data: chartData.feeBreakdown.map(function(d) { return d.value; }),
            backgroundColor: ['#10b981', '#ef4444'],
            borderWidth: 0,
            hoverOffset: 6,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '65%',
          plugins: {
            legend: { position: 'bottom' },
            tooltip: {
              callbacks: {
                label: function(ctx) { return ctx.label + ': Rs ' + ctx.parsed.toLocaleString(); }
              }
            }
          }
        }
      });
    }
  }
});
