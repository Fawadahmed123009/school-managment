// Dashboard charts — shared by TWO different pages that both load this
// same file path:
//   1. The main dashboard (admin/manager/teacher/student) — reads its data
//      from <script type="application/json" id="dashboard-data">.
//   2. The parent dashboard — reads its data from per-child JSON islands
//      <script type="application/json" class="child-chart-data"
//      data-child-id="…">.
// Both blocks below run independently and no-op if their expected data
// isn't present on the page, so this one file safely serves both.
document.addEventListener('DOMContentLoaded', function () {
  if (typeof Chart === 'undefined') return;

  // Match the existing dashboard / analysis-chart look
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#6b7280';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;
  Chart.defaults.elements.bar.borderRadius = 4;

  // ══════════════════════════════════════════════════════════════
  // 1. MAIN DASHBOARD (admin / manager / teacher / student)
  // ══════════════════════════════════════════════════════════════
  var mainDataEl = document.getElementById('dashboard-data');
  if (mainDataEl) {
    var mainPayload;
    try { mainPayload = JSON.parse(mainDataEl.textContent); } catch (e) { mainPayload = null; }

    if (mainPayload && mainPayload.charts) {
      var charts = mainPayload.charts;
      var role = mainPayload.role;

      // ── Attendance trend: admin/manager/teacher (#attendanceChart) ──
      // Data shape: [{ date, rate, total }]
      var attCanvas = document.getElementById('attendanceChart');
      var attEmpty = document.getElementById('attendanceEmpty');
      if (attCanvas) {
        var trend = (charts.attendanceTrend || []).filter(function (d) { return typeof d.rate === 'number'; });
        if (trend.length > 0) {
          new Chart(attCanvas, {
            type: 'line',
            data: {
              labels: trend.map(function (d) { return d.date; }),
              datasets: [{
                label: 'Attendance rate (%)',
                data: trend.map(function (d) { return d.rate; }),
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.08)',
                fill: true,
                tension: 0.35,
                pointRadius: 3,
                pointHoverRadius: 5,
                borderWidth: 2,
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                y: { beginAtZero: true, max: 100, ticks: { callback: function (v) { return v + '%'; } } },
                x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }
              },
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    label: function (ctx) {
                      var d = trend[ctx.dataIndex];
                      return d.rate + '% present (' + d.total + ' marked)';
                    }
                  }
                }
              }
            }
          });
        } else {
          attCanvas.style.display = 'none';
          if (attEmpty) attEmpty.style.display = 'flex';
        }
      }

      // ── Attendance present/absent/late donut (admin/manager) ──
      // Reuses the same 30-day attendance aggregation the trend line above is
      // drawn from (charts.attendanceBreakdown = { present, absent, late }) —
      // no second query. Guarded on its own canvas, so the parent portal (which
      // has neither #dashboard-data nor this canvas) is unaffected.
      var donutCanvas = document.getElementById('attendanceBreakdownChart');
      var donutEmpty = document.getElementById('attendanceBreakdownEmpty');
      if (donutCanvas) {
        var bd = charts.attendanceBreakdown || { present: 0, absent: 0, late: 0 };
        var bdTotal = (bd.present || 0) + (bd.absent || 0) + (bd.late || 0);
        if (bdTotal > 0) {
          new Chart(donutCanvas, {
            type: 'doughnut',
            data: {
              labels: ['Present', 'Absent', 'Late'],
              datasets: [{
                data: [bd.present, bd.absent, bd.late],
                backgroundColor: ['#10b981', '#ef4444', '#f59e0b'],
                borderWidth: 0,
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              cutout: '62%',
              plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                  callbacks: {
                    label: function (ctx) {
                      var pct = Math.round((ctx.parsed / bdTotal) * 1000) / 10;
                      return ctx.label + ': ' + ctx.parsed + ' (' + pct + '%)';
                    }
                  }
                }
              }
            }
          });
        } else {
          donutCanvas.style.display = 'none';
          if (donutEmpty) donutEmpty.style.display = 'flex';
        }
      }

      // ── Attendance: student's own (#studentAttChart) ──
      // Data shape: [{ date, status }] where status is 'present'/'absent'/'late'
      var studAttCanvas = document.getElementById('studentAttChart');
      var studAttEmpty = document.getElementById('studentAttEmpty');
      if (studAttCanvas) {
        var studTrend = (charts.attendanceTrend || []).filter(function (d) { return d.status; });
        if (studTrend.length > 0) {
          var statusValue = { present: 1, late: 0.5, absent: 0 };
          var statusColor = { present: '#10b981', late: '#f59e0b', absent: '#ef4444' };
          new Chart(studAttCanvas, {
            type: 'bar',
            data: {
              labels: studTrend.map(function (d) { return d.date; }),
              datasets: [{
                label: 'Attendance',
                data: studTrend.map(function (d) { return statusValue[d.status] != null ? statusValue[d.status] : 0; }),
                backgroundColor: studTrend.map(function (d) { return statusColor[d.status] || '#9ca3af'; }),
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                y: { beginAtZero: true, max: 1, ticks: { display: false } },
                x: { grid: { display: false } }
              },
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    label: function (ctx) {
                      var d = studTrend[ctx.dataIndex];
                      return d.status.charAt(0).toUpperCase() + d.status.slice(1);
                    }
                  }
                }
              }
            }
          });
        } else {
          studAttCanvas.style.display = 'none';
          if (studAttEmpty) studAttEmpty.style.display = 'flex';
        }
      }

      // ── This week's tests: marked vs unmarked per day (teacher) ──
      // Data shape: charts.weekTests = { subjectName, days: [{ label, date, marked, unmarked }] }
      var weekCanvas = document.getElementById('weekTestsChart');
      var weekEmpty = document.getElementById('weekTestsEmpty');
      if (weekCanvas) {
        var week = charts.weekTests || { days: [] };
        var hasAny = (week.days || []).some(function (d) { return d.marked > 0 || d.unmarked > 0; });
        if (hasAny) {
          new Chart(weekCanvas, {
            type: 'bar',
            data: {
              labels: (week.days || []).map(function (d) { return d.label; }),
              datasets: [
                {
                  label: 'Marked',
                  data: (week.days || []).map(function (d) { return d.marked; }),
                  backgroundColor: '#10b981',
                  stack: 's',
                },
                {
                  label: 'Unmarked',
                  data: (week.days || []).map(function (d) { return d.unmarked; }),
                  backgroundColor: '#ef4444',
                  stack: 's',
                }
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                x: { stacked: true, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1, precision: 0 } }
              },
              plugins: {
                legend: { display: true },
                tooltip: {
                  callbacks: {
                    title: function (items) {
                      var d = (week.days || [])[items[0].dataIndex];
                      return d ? d.label + ' · ' + d.date : '';
                    },
                    label: function (ctx) { return ctx.dataset.label + ': ' + ctx.parsed.y + ' test' + (ctx.parsed.y === 1 ? '' : 's'); }
                  }
                }
              }
            }
          });
        } else {
          weekCanvas.style.display = 'none';
          if (weekEmpty) weekEmpty.style.display = 'flex';
        }
      }

      // ── Fee collection: admin only (#feeCollectionChart) ──
      // Pie of collected Rs per month (was a grouped bar). Each slice is one
      // month's collected total; empty-state shows when nothing has landed yet.
      var feeCanvas = document.getElementById('feeCollectionChart');
      var feeEmpty = document.getElementById('feeEmpty');
      if (feeCanvas) {
        var feeCollection = (charts.feeCollection || []).filter(function (d) { return (d.collected || 0) > 0; });
        if (feeCollection.length > 0) {
          var feePalette = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6', '#ef4444'];
          new Chart(feeCanvas, {
            type: 'pie',
            data: {
              labels: feeCollection.map(function (d) { return d.month; }),
              datasets: [{
                data: feeCollection.map(function (d) { return d.collected; }),
                backgroundColor: feeCollection.map(function (d, i) { return feePalette[i % feePalette.length]; }),
                borderWidth: 0,
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                  callbacks: {
                    label: function (ctx) { return ctx.label + ': Rs ' + ctx.parsed.toLocaleString(); }
                  }
                }
              }
            }
          });
        } else {
          feeCanvas.style.display = 'none';
          if (feeEmpty) feeEmpty.style.display = 'flex';
        }
      }

      // ── Fee breakdown by type: admin only (#feeBreakdownChart) ──
      // Data shape: [{ type, total, paid }]
      var breakdownCanvas = document.getElementById('feeBreakdownChart');
      var breakdownEmpty = document.getElementById('breakdownEmpty');
      if (breakdownCanvas) {
        var feeBreakdown = charts.feeBreakdown || [];
        if (feeBreakdown.length > 0) {
          new Chart(breakdownCanvas, {
            type: 'bar',
            data: {
              labels: feeBreakdown.map(function (d) { return d.type; }),
              datasets: [
                {
                  label: 'Paid',
                  data: feeBreakdown.map(function (d) { return d.paid; }),
                  backgroundColor: '#10b981',
                },
                {
                  label: 'Pending',
                  data: feeBreakdown.map(function (d) { return d.total - d.paid; }),
                  backgroundColor: '#f59e0b',
                }
              ]
            },
            options: {
              indexAxis: 'y',
              responsive: true,
              maintainAspectRatio: false,
              scales: {
                x: {
                  stacked: true,
                  beginAtZero: true,
                  ticks: { callback: function (v) { return 'Rs ' + v.toLocaleString(); } }
                },
                y: { stacked: true, grid: { display: false } }
              },
              plugins: {
                legend: { display: true },
                tooltip: {
                  callbacks: {
                    label: function (ctx) { return ctx.dataset.label + ': Rs ' + ctx.parsed.x.toLocaleString(); }
                  }
                }
              }
            }
          });
        } else {
          breakdownCanvas.style.display = 'none';
          if (breakdownEmpty) breakdownEmpty.style.display = 'flex';
        }
      }

      // ── Teacher test records are now rendered server-side as a table
      // (views/partials/dashboard-teacher-tests.ejs), so there is no canvas for
      // this on the dashboard any more. Nothing to draw here.
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 2. PARENT DASHBOARD — per-child progress + subject charts
  // ══════════════════════════════════════════════════════════════
  var islands = document.querySelectorAll('.child-chart-data');

  islands.forEach(function (island) {
    var childId = island.getAttribute('data-child-id');
    if (!childId) return;

    var payload;
    try { payload = JSON.parse(island.textContent); } catch (e) { return; }

    var progress = payload.progress || [];
    var bySubject = payload.bySubject || [];

    // ── Test progress (line chart) ──
    var progCanvas = document.getElementById('progressChart-' + childId);
    var progEmpty = document.getElementById('progressEmpty-' + childId);
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
                  label: function (ctx) { return ctx.parsed.y.toFixed(2) + '% average'; }
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

    // ── Subject-wise performance (horizontal bar chart) ──
    var subjCanvas = document.getElementById('subjectChart-' + childId);
    var subjEmpty = document.getElementById('subjectEmpty-' + childId);
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
                    return d.average.toFixed(2) + '% avg over ' + d.count + ' test' + (d.count === 1 ? '' : 's');
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
});

// ══════════════════════════════════════════════════════════════
// 3. TOP PERFORMERS — per-grade tab switcher
// ══════════════════════════════════════════════════════════════
// Runs independently of Chart.js so the grade tabs still work even if the
// chart CDN fails. Each list is fully server-rendered; switching a tab only
// toggles which .tp-list is visible — no refetch, no re-templating, no nav.
// Scoped to the tab's own .panel: Top Performers and At-Risk each carry a
// full set of pre-rendered .tp-list grades, and the two groups must toggle
// independently.
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.panel').forEach(function (panel) {
    var tabs = panel.querySelectorAll('button.tp-tab');
    var lists = panel.querySelectorAll('.tp-list');
    if (!tabs.length || !lists.length) return;
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var grade = tab.getAttribute('data-grade');
        tabs.forEach(function (t) {
          var on = t === tab;
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        lists.forEach(function (list) {
          list.style.display = list.getAttribute('data-grade') === grade ? '' : 'none';
        });
      });
    });
  });
});