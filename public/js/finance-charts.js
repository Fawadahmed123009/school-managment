// Finance trend charts — the visual layer on top of the Phase 4 reports.
// Data arrives via a CSP-safe JSON island: <script type="application/json"
// id="finance-chart-data">. Every figure is the SAME report data the tables
// show (by-head rows straight from the report; trend points are the existing
// monthly/daily reports composed server-side) — nothing is recomputed here.
document.addEventListener('DOMContentLoaded', function () {
  var dataEl = document.getElementById('finance-chart-data');
  if (!dataEl) return;
  var payload;
  try { payload = JSON.parse(dataEl.textContent); } catch (e) { return; }

  // ── shared helpers ──────────────────────────────────────────────────────
  var COLORS = {
    collections: '#2563eb', // stat-card accent-blue
    income: '#059669',      // accent-green
    expenses: '#dc2626',    // accent-red
    salaries: '#c8a84b',    // accent-gold
    netPos: '#059669',
    netNeg: '#dc2626',
  };
  // By-head donut palette — theme-derived hues, separable by luminance too.
  var HEAD_PALETTE = ['#2563eb', '#059669', '#c8a84b', '#7c3aed', '#dc2626', '#0891b2', '#d97706', '#64748b'];
  var MAX_SLICES = 8; // top 7 heads + "Other" (display grouping of computed rows)

  function fmtMoney(v) {
    return 'Rs ' + Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  // Compact axis/center money: 1.2Cr / 3.4L / 56k (PKR-friendly short scales).
  function compact(v) {
    var n = Number(v || 0);
    var abs = Math.abs(n);
    var trim = function (x) { return (Math.round(x * 10) / 10).toString().replace(/\.0$/, ''); };
    if (abs >= 1e7) return trim(n / 1e7) + 'Cr';
    if (abs >= 1e5) return trim(n / 1e5) + 'L';
    if (abs >= 1e3) return trim(n / 1e3) + 'k';
    return String(Math.round(n));
  }
  function showEmpty(canvasId, emptyId, msg) {
    var c = document.getElementById(canvasId);
    var e = document.getElementById(emptyId);
    if (c) c.style.display = 'none';
    if (e) { e.textContent = msg; e.style.display = 'flex'; }
  }
  function noteAfter(panelEl, msg) {
    if (!panelEl) return;
    var n = document.createElement('div');
    n.className = 'fin-trend-note';
    n.textContent = msg;
    panelEl.appendChild(n);
  }

  // ── offline / CDN-blocked fallback: tables stay, charts degrade to a note ─
  if (typeof Chart === 'undefined') {
    ['finTrendChart', 'finDailyChart'].forEach(function (id) {
      var emptyId = id === 'finTrendChart' ? 'finTrendEmpty' : 'finDailyEmpty';
      if (document.getElementById(id)) {
        showEmpty(id, emptyId, 'Charts are unavailable offline — the tables below contain the full figures.');
      }
    });
    ['finIncomeDonut', 'finExpenseDonut'].forEach(function (id) {
      var c = document.getElementById(id);
      if (c && c.closest('.fin-breakdown')) {
        c.closest('.fin-donut-wrap').style.display = 'none';
        c.closest('.fin-breakdown').classList.add('fin-breakdown--solo');
      }
    });
    var chips = document.getElementById('finTrendChips');
    if (chips) chips.style.display = 'none';
    return;
  }

  // Match the existing dashboard / analysis-chart look (Inter, muted ticks,
  // point-style legends, rounded bars).
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#6b7280';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyleWidth = 8;
  Chart.defaults.elements.bar.borderRadius = 4;

  var moneyScale = {
    grace: '8%',
    border: { display: false },
    grid: {
      color: function (ctx) { return ctx.tick && ctx.tick.value === 0 ? '#9ca3af' : '#eef0f4'; },
    },
    ticks: { callback: function (v) { return 'Rs ' + compact(v); }, maxTicksLimit: 7 },
  };
  var tooltipTheme = {
    backgroundColor: '#1a2744',
    titleColor: '#f4f6fb',
    bodyColor: '#e5e7eb',
    padding: 10,
    cornerRadius: 8,
    boxPadding: 4,
    titleFont: { family: "'Inter', sans-serif", weight: '600' },
  };

  // ══════════════════════════════════════════════════════════════════════
  // 1. YEARLY — monthly trend combo: net bars (green profit / red loss) +
  //    collections / income / expenses / salaries comparison lines. Chips
  //    in the panel head toggle each series (they ARE the legend).
  // ══════════════════════════════════════════════════════════════════════
  var trendCanvas = document.getElementById('finTrendChart');
  if (trendCanvas && payload.trend && payload.trend.months) {
    var months = payload.trend.months;
    var okMonths = months.filter(function (m) { return m.ok; });
    var failed = months.length - okMonths.length;
    var activity = okMonths.some(function (m) {
      return (m.collections || 0) + (m.income || 0) + (m.expenses || 0) + (m.salaries || 0) !== 0;
    });

    if (!activity) {
      showEmpty('finTrendChart', 'finTrendEmpty', 'No financial activity recorded in ' + payload.trend.year + '.');
      var chipsOff = document.getElementById('finTrendChips');
      if (chipsOff) chipsOff.style.display = 'none';
    } else {
      var seriesOf = function (key) {
        return months.map(function (m) { return m.ok ? m[key] : null; });
      };
      var netVals = seriesOf('net');
      var line = function (key, label) {
        return {
          type: 'line',
          label: label,
          data: seriesOf(key),
          borderColor: COLORS[key],
          backgroundColor: COLORS[key],
          pointBackgroundColor: COLORS[key],
          pointBorderColor: '#ffffff',
          pointBorderWidth: 1,
          pointRadius: 2.5,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0.35,
          spanGaps: false,
          fill: false,
          hidden: key === 'salaries', // comparison extra — off by default
        };
      };

      var trendChart = new Chart(trendCanvas, {
        data: {
          labels: months.map(function (m) { return m.label; }),
          datasets: [
            {
              type: 'bar',
              label: 'Net profit/loss',
              data: netVals,
              backgroundColor: netVals.map(function (v) {
                return v !== null && v < 0 ? 'rgba(220, 38, 38, 0.45)' : 'rgba(5, 150, 105, 0.5)';
              }),
              borderColor: netVals.map(function (v) { return v !== null && v < 0 ? COLORS.netNeg : COLORS.netPos; }),
              borderWidth: 1.5,
              borderRadius: 4,
              maxBarThickness: 34,
            },
            line('collections', 'Collections'),
            line('income', 'Income'),
            line('expenses', 'Expenses'),
            line('salaries', 'Salaries'),
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false }, // chips are the legend
            tooltip: Object.assign({}, tooltipTheme, {
              callbacks: {
                title: function (items) { return items[0].label + ' ' + payload.trend.year; },
                label: function (ctx) { return ' ' + ctx.dataset.label + ': ' + fmtMoney(ctx.parsed.y); },
              },
            }),
          },
          scales: {
            x: { grid: { display: false }, border: { display: false } },
            y: moneyScale,
          },
        },
      });

      // Chip toggles — dataset order matches data-series keys.
      var seriesIndex = { net: 0, collections: 1, income: 2, expenses: 3, salaries: 4 };
      var chipBox = document.getElementById('finTrendChips');
      if (chipBox) {
        Array.prototype.forEach.call(chipBox.querySelectorAll('.fin-chip'), function (chip) {
          var idx = seriesIndex[chip.getAttribute('data-series')];
          if (idx === undefined) return;
          // Sync initial visual state with aria-pressed (salaries starts off).
          chip.classList.toggle('fin-chip--off', chip.getAttribute('aria-pressed') !== 'true');
          chip.addEventListener('click', function () {
            var visible = !trendChart.isDatasetVisible(idx);
            trendChart.setDatasetVisibility(idx, visible);
            chip.setAttribute('aria-pressed', String(visible));
            chip.classList.toggle('fin-chip--off', !visible);
            trendChart.update();
          });
        });
      }
      if (failed > 0) {
        noteAfter(trendCanvas.closest('.fin-chart-panel'), failed + ' month' + (failed > 1 ? 's' : '') + ' could not be loaded — shown as gaps.');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 2. MONTHLY — daily net bars across the month (future days are gaps).
  // ══════════════════════════════════════════════════════════════════════
  var dailyCanvas = document.getElementById('finDailyChart');
  if (dailyCanvas && payload.dailyTrend && payload.dailyTrend.days) {
    var days = payload.dailyTrend.days;
    var dayVals = days.map(function (d) { return d.ok && !d.future ? d.net : null; });
    var dayActivity = dayVals.some(function (v) { return v !== null && v !== 0; });
    var dayFailed = days.filter(function (d) { return !d.ok; }).length;

    if (!dayActivity) {
      showEmpty('finDailyChart', 'finDailyEmpty', 'No activity recorded this month yet.');
    } else {
      new Chart(dailyCanvas, {
        type: 'bar',
        data: {
          labels: days.map(function (d) { return d.day; }),
          datasets: [{
            label: 'Daily net',
            data: dayVals,
            backgroundColor: dayVals.map(function (v) {
              return v !== null && v < 0 ? 'rgba(220, 38, 38, 0.5)' : 'rgba(5, 150, 105, 0.55)';
            }),
            borderColor: dayVals.map(function (v) { return v !== null && v < 0 ? COLORS.netNeg : COLORS.netPos; }),
            borderWidth: 1,
            borderRadius: 3,
            barPercentage: 0.72,
            categoryPercentage: 0.9,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: Object.assign({}, tooltipTheme, {
              callbacks: {
                title: function (items) {
                  var d = days[items[0].dataIndex];
                  return new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, {
                    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                  });
                },
                label: function (ctx) { return ' Net: ' + fmtMoney(ctx.parsed.y); },
                afterBody: function (items) {
                  var d = days[items[0].dataIndex];
                  if (!d || !d.ok) return '';
                  return [
                    'Collections: ' + fmtMoney(d.collections),
                    'Income: ' + fmtMoney(d.income),
                    'Expenses: ' + fmtMoney(d.expenses),
                    'Salaries: ' + fmtMoney(d.salaries),
                  ];
                },
              },
            }),
          },
          scales: {
            x: {
              grid: { display: false },
              border: { display: false },
              ticks: { autoSkip: true, maxTicksLimit: 16, font: { size: 10.5 } },
            },
            y: moneyScale,
          },
        },
      });
      if (dayFailed > 0) {
        noteAfter(dailyCanvas.closest('.fin-chart-panel'), dayFailed + ' day' + (dayFailed > 1 ? 's' : '') + ' could not be loaded — shown as gaps.');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 3. BY-HEAD DONUTS (monthly + yearly) — the report's computed rows as
  //    proportions; the table beside each donut is its legend, so slice
  //    colors are dotted into the matching table rows.
  // ══════════════════════════════════════════════════════════════════════
  function renderDonut(canvasId, rows, kind) {
    var canvas = document.getElementById(canvasId);
    if (!canvas || !rows || rows.length === 0) return;

    // Display-only grouping: top 7 heads + "Other" when there are many —
    // sums of the ALREADY-computed rows, never a re-aggregation.
    var slices = rows;
    if (rows.length > MAX_SLICES) {
      var top = rows.slice(0, MAX_SLICES - 1);
      var rest = rows.slice(MAX_SLICES - 1);
      var otherTotal = rest.reduce(function (s, r) { return s + r.total; }, 0);
      slices = top.concat([{ name: 'Other (' + rest.length + ' heads)', total: otherTotal, count: rest.reduce(function (s, r) { return s + r.count; }, 0) }]);
    }
    var total = rows.reduce(function (s, r) { return s + r.total; }, 0);
    var colors = slices.map(function (_, i) { return HEAD_PALETTE[i % HEAD_PALETTE.length]; });

    new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: slices.map(function (s) { return s.name; }),
        datasets: [{
          data: slices.map(function (s) { return s.total; }),
          backgroundColor: colors,
          borderColor: '#ffffff',
          borderWidth: 2,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { display: false }, // the adjacent table is the legend
          tooltip: Object.assign({}, tooltipTheme, {
            callbacks: {
              label: function (ctx) {
                var pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : '0.0';
                return ' ' + ctx.label + ': ' + fmtMoney(ctx.parsed) + ' (' + pct + '%)';
              },
            },
          }),
        },
      },
    });

    // Link table rows to slice colors (rows arrive in the same total-desc
    // order as the slices; grouped tail rows share the "Other" color).
    var table = document.querySelector('table[data-fin-heads="' + kind + '"]');
    if (table) {
      var trs = table.querySelectorAll('tbody tr');
      Array.prototype.forEach.call(trs, function (tr, i) {
        var colorIdx = rows.length > MAX_SLICES ? Math.min(i, MAX_SLICES - 1) : i;
        var td = tr.querySelector('td');
        if (!td) return;
        var dot = document.createElement('span');
        dot.className = 'fin-head-dot';
        dot.style.background = colors[colorIdx % colors.length];
        td.insertBefore(dot, td.firstChild);
      });
    }
  }

  renderDonut('finIncomeDonut', payload.incomeByHead, 'income');
  renderDonut('finExpenseDonut', payload.expensesByHead, 'expense');
});