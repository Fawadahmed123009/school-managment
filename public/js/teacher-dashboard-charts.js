// Teacher dashboard charts — ApexCharts renderer.
//
// Loaded ONLY on the plain-teacher dashboard (views/dashboard.ejs) via
//   <script src="https://cdn.jsdelivr.net/npm/apexcharts">  (library)
//   <script type="application/json" id="teacher-charts-data">  (data island)
//   <script src="/js/teacher-dashboard-charts.js">  (this file)
//
// It draws THREE widgets from the one JSON island:
//   #tdAttTrend  → ApexCharts gradient-filled smooth area chart (attendance rate)
//   #tdAttMix    → Chart.js doughnut, reference "Students" styling: thick ring,
//                  gradient stroke, rounded segment caps, soft drop-shadow, centre %
//   #tdClassAvg  → ApexCharts column chart (test average per class)
//
// Everything is presentation-only: the data comes from the same aggregations the
// previous charts used (charts.attendanceTrend / attendanceBreakdown) plus the
// route-derived stats.teacher.classAverages. No query is issued here. External
// file with no inline handlers, so it stays CSP-safe (script-src 'self').
document.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('teacher-charts-data');
  if (!el) return;

  var data;
  try { data = JSON.parse(el.textContent); } catch (e) { return; }
  data = data || {};

  // Shared palette / typography so the charts read like the rest of the app.
  var COLOR_GREEN = '#10b981';   // present / good
  var COLOR_RED = '#ef4444';     // absent
  var COLOR_AMBER = '#f59e0b';   // late / review
  var COLOR_PURPLE = '#7c3aed';  // --ocr accent
  var FONT = "'Inter', sans-serif";
  var AXIS = '#6b7280';

  var base = {
    chart: {
      fontFamily: FONT,
      toolbar: { show: false },
      animations: { enabled: true, speed: 380 },
    },
    grid: { borderColor: '#eef1f6', strokeDashArray: 4, xaxis: { lines: { show: false } } },
    tooltip: { theme: 'light', style: { fontFamily: FONT } },
  };

  function merge(extra) {
    var out = JSON.parse(JSON.stringify(base));
    Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  function showEmpty(canvasSel, emptySel) {
    var c = document.querySelector(canvasSel);
    var e = document.getElementById(emptySel);
    if (c) c.style.display = 'none';
    if (e) e.style.display = 'block';
  }

  // ── 1. Attendance trend — smooth gradient area (ApexCharts) ──────────
  (function () {
    if (typeof ApexCharts === 'undefined') return;
    var trend = (data.attendanceTrend || []).filter(function (d) { return typeof d.rate === 'number'; });
    var host = document.getElementById('tdAttTrend');
    if (!host) return;
    if (trend.length === 0) { showEmpty('#tdAttTrend', 'tdAttTrendEmpty'); return; }

    new ApexCharts(host, merge({
      chart: { type: 'area', height: 300, sparkline: { enabled: false }, zoom: { enabled: false } },
      series: [{ name: 'Attendance rate', data: trend.map(function (d) { return d.rate; }) }],
      xaxis: {
        categories: trend.map(function (d) { return d.date; }),
        labels: { style: { colors: AXIS, fontSize: '11px' }, rotate: -45, hideOverlappingLabels: true },
        axisBorder: { show: false }, axisTicks: { show: false },
        tooltip: { enabled: false },
      },
      yaxis: {
        min: 0, max: 100, tickAmount: 4,
        labels: { style: { colors: AXIS, fontSize: '11px' }, formatter: function (v) { return Math.round(v) + '%'; } },
      },
      colors: [COLOR_GREEN],
      stroke: { curve: 'smooth', width: 2.5 },
      fill: {
        type: 'gradient',
        gradient: { shadeIntensity: 1, opacityFrom: 0.55, opacityTo: 0.02, stops: [0, 90, 100] },
      },
      dataLabels: { enabled: false },
      legend: { show: false },
      tooltip: {
        theme: 'light',
        custom: function (o) {
          var d = trend[o.seriesIndex !== undefined ? o.dataPointIndex : o.dataPointIndex];
          if (!d) return '';
          var pct = d.rate + '% present';
          var tot = (d.total ? ' <span style="color:' + AXIS + '">· ' + d.total + ' marked</span>' : '');
          return '<div style="padding:8px 12px;font-family:' + FONT + ';font-size:12px;">'
            + '<div style="font-weight:600;margin-bottom:2px;">' + o.w.globals.labels[o.dataPointIndex] + '</div>'
            + '<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + COLOR_GREEN + ';margin-right:6px;"></span>'
            + pct + tot + '</div></div>';
        },
      },
      markers: { size: 0, hover: { size: 5 } },
    })).render();
  })();

  // ── 2. Attendance mix — Chart.js doughnut, reference "Students" styling ─
  // Thick ring (low cutout), per-slice radial gradient stroke, rounded segment
  // caps (borderRadius), soft drop-shadow cast by the arcs, and the overall %
  // kept in the centre. ApexCharts has no rounded slice caps, so this one widget
  // stays on Chart.js — which the page already loads for the weekly chart.
  (function () {
    var canvas = document.getElementById('tdAttMix');
    if (!canvas || typeof Chart === 'undefined') return;

    var bd = data.attendanceBreakdown || { present: 0, absent: 0, late: 0 };
    var total = (bd.present || 0) + (bd.absent || 0) + (bd.late || 0);
    if (total === 0) { showEmpty('#tdAttMix', 'tdAttMixEmpty'); return; }

    var rate = data.attendanceRate;
    var centreLabel = (typeof rate === 'number' ? rate + '%' : Math.round(((bd.present + bd.late) / total) * 100) + '%');

    // light → base stops so each band reads as a sheen, not a flat fill.
    var SEG = [
      { label: 'Present', base: COLOR_GREEN, light: '#6ee7b7' },
      { label: 'Absent',  base: COLOR_RED,   light: '#fca5a5' },
      { label: 'Late',    base: COLOR_AMBER, light: '#fcd34d' },
    ];

    function radialFill(context, seg) {
      var chart = context.chart, area = chart.chartArea;
      if (!area) return seg.base;
      var cx = (area.left + area.right) / 2;
      var cy = (area.top + area.bottom) / 2;
      var r = Math.min(area.right - area.left, area.bottom - area.top) / 2;
      var g = chart.ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
      g.addColorStop(0, seg.light);
      g.addColorStop(1, seg.base);
      return g;
    }

    // soft drop-shadow while the arcs draw, then restore the context.
    var shadowPlugin = {
      id: 'tdMixShadow',
      beforeDatasetDraw: function (c) {
        var ctx = c.ctx;
        ctx.save();
        ctx.shadowColor = 'rgba(15, 23, 42, 0.18)';
        ctx.shadowBlur = 18;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 10;
      },
      afterDatasetDraw: function (c) { c.ctx.restore(); },
    };

    // centre text: small grey label above, bold % below (kept from the old donut).
    var centrePlugin = {
      id: 'tdMixCentre',
      afterDraw: function (c) {
        var arc = (c.getDatasetMeta(0).data || [])[0];
        if (!arc) return;
        var ctx = c.ctx;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = AXIS;
        ctx.font = '600 12px ' + FONT;
        ctx.fillText('Overall attendance', arc.x, arc.y - 14);
        ctx.fillStyle = COLOR_GREEN;
        ctx.font = '700 30px ' + FONT;
        ctx.fillText(centreLabel, arc.x, arc.y + 10);
        ctx.restore();
      },
    };

    new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: SEG.map(function (s) { return s.label; }),
        datasets: [{
          data: [bd.present || 0, bd.absent || 0, bd.late || 0],
          backgroundColor: function (context) {
            var s = SEG[context.dataIndex];
            return s ? radialFill(context, s) : '#9ca3af';
          },
          borderWidth: 0,
          borderRadius: 10,
          spacing: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        layout: { padding: 8 },
        plugins: {
          legend: { position: 'bottom', labels: { color: AXIS, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, padding: 14 } },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var p = Math.round((ctx.parsed / total) * 1000) / 10;
                return ctx.label + ': ' + ctx.parsed + ' (' + p + '%)';
              },
            },
          },
        },
      },
      plugins: [shadowPlugin, centrePlugin],
    });
  })();

  // ── 3. Test averages by class — column chart (ApexCharts) ────────────
  (function () {
    if (typeof ApexCharts === 'undefined') return;
    var rows = (data.classAverages || []).filter(function (c) { return typeof c.avg === 'number'; });
    var host = document.getElementById('tdClassAvg');
    if (!host) return;
    if (rows.length === 0) { showEmpty('#tdClassAvg', 'tdClassAvgEmpty'); return; }

    new ApexCharts(host, merge({
      chart: { type: 'bar', height: 320, zoom: { enabled: false } },
      series: [{ name: 'Average score', data: rows.map(function (c) { return c.avg; }) }],
      xaxis: {
        categories: rows.map(function (c) { return c.class; }),
        labels: { style: { colors: AXIS, fontSize: '11px' }, rotate: -30, rotateAlways: rows.length > 6 },
        axisBorder: { show: false }, axisTicks: { show: false },
      },
      yaxis: {
        min: 0, max: 100, tickAmount: 4,
        labels: { style: { colors: AXIS, fontSize: '11px' }, formatter: function (v) { return Math.round(v) + '%'; } },
      },
      colors: [COLOR_PURPLE],
      plotOptions: {
        bar: {
          columnWidth: '55%', borderRadius: 6,
          dataLabels: { position: 'top' },
        },
      },
      dataLabels: {
        enabled: true,
        formatter: function (val) { return val + '%'; },
        textAnchor: 'middle',
        style: { fontSize: '11px', fontWeight: 700, colors: [COLOR_PURPLE] },
        dropShadow: { enabled: false },
      },
      legend: { show: false },
      tooltip: { y: { formatter: function (val, opt) { var r = rows[opt.dataPointIndex]; return val + '% · ' + (r && r.students ? r.students : 0) + ' students'; } } },
    })).render();
  })();
});
