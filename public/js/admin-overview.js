// Unified Admin Overview — client layer for /admin/overview.
//
// Each panel fetches its OWN JSON endpoint independently, so the slowest
// query can never block the rest of the page. Endpoints are pure adapters
// over the existing services (see routes/views/adminOverview.views.js) —
// this file only composes the DOM: no figure is calculated client-side
// beyond display formatting (money strings, relative times), and all text
// is inserted via textContent / createElement (no innerHTML with data).
(function () {
  'use strict';

  // ── display helpers (UX only — every number comes from the server) ──────
  function fmtMoney(v) {
    return 'Rs ' + Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function compact(v) {
    var n = Number(v || 0);
    var abs = Math.abs(n);
    var trim = function (x) { return (Math.round(x * 10) / 10).toString().replace(/\.0$/, ''); };
    if (abs >= 1e7) return trim(n / 1e7) + 'Cr';
    if (abs >= 1e5) return trim(n / 1e5) + 'L';
    if (abs >= 1e3) return trim(n / 1e3) + 'k';
    return String(Math.round(n));
  }
  function relTime(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' h ago';
    var days = Math.round(hrs / 24);
    return days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function clearBody(body) {
    while (body.firstChild) body.removeChild(body.firstChild);
  }

  // A section header inside a panel body ("No expected time · 2").
  function aoSection(titleText, count, tone) {
    var head = el('div', 'ao-section' + (tone ? ' ao-section--' + tone : ''));
    head.appendChild(el('span', 'ao-section-title', titleText));
    head.appendChild(el('span', 'ao-count', String(count)));
    return head;
  }
  function aoRowLink(href, mainText, subText) {
    var a = el('a', 'ao-row', null);
    a.href = href;
    a.appendChild(el('span', 'ao-row-main', mainText));
    if (subText) a.appendChild(el('span', 'ao-row-sub', subText));
    a.appendChild(el('span', 'ao-row-fix', 'Fix →'));
    return a;
  }

  // ── per-panel renderers — each receives { ok, data | error } ─────────────
  var RENDERERS = {

    finance: function (panel, body, data) {
      var netClass = function (net) { return net < 0 ? 'ao-net ao-net--neg' : 'ao-net ao-net--pos'; };

      var kpis = el('div', 'ao-kpis');
      [['Today', data.today], ['This month', data.monthToDate]].forEach(function (pair) {
        var card = el('div', 'ao-kpi');
        card.appendChild(el('div', 'ao-kpi-label', pair[0]));
        card.appendChild(el('div', netClass(pair[1].net), fmtMoney(pair[1].net)));
        // Breakdown shown straight from the net-summary contract — the two
        // sums the server already defines (in = collections + income, out =
        // expenses) are NOT recomputed here; each figure is displayed as-is.
        card.appendChild(el('div', 'ao-kpi-sub',
          'Collections ' + compact(pair[1].collections) + ' · Income ' + compact(pair[1].income) + ' · Expenses ' + compact(pair[1].expenses)));
        kpis.appendChild(card);
      });
      body.appendChild(kpis);

      // Sparkline — the SAME daily-trend points the monthly finance report
      // charts (financeTrend.getDailyTrend). Bars only, no axes chrome.
      var wrap = el('div', 'ao-spark');
      var canvas = document.createElement('canvas');
      canvas.id = 'aoSparkline';
      wrap.appendChild(canvas);
      var caption = el('div', 'ao-spark-caption', 'Daily net · ' + data.month);
      body.appendChild(wrap);
      body.appendChild(caption);

      var days = (data.sparkline && data.sparkline.days) || [];
      var values = days.map(function (d) { return d.ok && !d.future ? d.net : null; });
      var activity = values.some(function (v) { return v !== null && v !== 0; });

      if (typeof Chart === 'undefined' || !activity) {
        wrap.style.display = 'none';
        caption.textContent = typeof Chart === 'undefined'
          ? 'Charts are unavailable offline — open the monthly report for full figures.'
          : 'No financial activity recorded this month yet.';
        return;
      }
      new Chart(canvas, {
        type: 'bar',
        data: {
          labels: days.map(function (d) { return d.day; }),
          datasets: [{
            label: 'Daily net',
            data: values,
            backgroundColor: values.map(function (v) {
              return v !== null && v < 0 ? 'rgba(220, 38, 38, 0.5)' : 'rgba(5, 150, 105, 0.55)';
            }),
            borderColor: values.map(function (v) { return v !== null && v < 0 ? '#dc2626' : '#059669'; }),
            borderWidth: 1,
            borderRadius: 2,
            barPercentage: 0.75,
            categoryPercentage: 0.92,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1a2744',
              titleColor: '#f4f6fb',
              bodyColor: '#e5e7eb',
              padding: 8,
              cornerRadius: 6,
              callbacks: {
                title: function (items) {
                  var d = days[items[0].dataIndex];
                  return new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, {
                    weekday: 'short', day: 'numeric', month: 'short',
                  });
                },
                label: function (ctx) { return ' Net: ' + fmtMoney(ctx.parsed.y); },
              },
            },
          },
          scales: {
            x: { display: false, grid: { display: false } },
            y: {
              grace: '8%',
              border: { display: false },
              grid: {
                color: function (ctx) { return ctx.tick && ctx.tick.value === 0 ? '#9ca3af' : '#eef0f4'; },
              },
              ticks: { callback: function (v) { return compact(v); }, maxTicksLimit: 4, font: { size: 10 } },
            },
          },
        },
      });
    },

    attention: function (panel, body, data) {
      var badge = panel.querySelector('[data-ao-badge]');
      var total = data.counts.noExpectedTime + data.counts.noPayConfig + data.counts.payNotEffective;
      if (badge) {
        badge.hidden = false;
        badge.textContent = total === 0 ? 'All clear' : total + ' open item' + (total === 1 ? '' : 's');
        badge.classList.add(total === 0 ? 'ao-badge--ok' : 'ao-badge--warn');
      }

      if (total === 0) {
        body.appendChild(el('div', 'ao-allclear',
          'Every active staff member has an expected arrival time and an effective pay config.'));
        return;
      }

      if (data.counts.noExpectedTime > 0) {
        body.appendChild(aoSection('No expected arrival time', data.counts.noExpectedTime, 'warn'));
        body.appendChild(el('p', 'ao-hint', 'Late detection is skipped for these staff — it can never judge them.'));
        data.noExpectedTime.forEach(function (t) {
          body.appendChild(aoRowLink(t.fixUrl, t.name + (t.teacherId ? ' · ' + t.teacherId : ''), 'Set expected times'));
        });
      }
      if (data.counts.noPayConfig > 0) {
        body.appendChild(aoSection('No pay config', data.counts.noPayConfig, 'warn'));
        body.appendChild(el('p', 'ao-hint', 'Salary runs fail closed for these staff until a rate is set.'));
        data.noPayConfig.forEach(function (r) {
          body.appendChild(aoRowLink(r.fixUrl, r.name, 'Add pay config'));
        });
      }
      if (data.counts.payNotEffective > 0) {
        body.appendChild(aoSection('Pay config not effective yet', data.counts.payNotEffective, 'muted'));
        data.payNotEffective.forEach(function (r) {
          var from = r.effectiveFrom ? new Date(r.effectiveFrom).toLocaleDateString() : '—';
          body.appendChild(aoRowLink(r.fixUrl, r.name, 'Effective from ' + from));
        });
      }
    },

    attendance: function (panel, body, data) {
      var s = data.summary || {};
      var present = (s.marked || 0) - (s.lateCount || 0);

      var stats = el('div', 'ao-att-stats');
      [
        ['On time', present, 'ao-att-num--ok'],
        ['Late', s.lateCount || 0, (s.lateCount || 0) > 0 ? 'ao-att-num--late' : ''],
        ['Not marked', data.notYetMarkedCount, (data.notYetMarkedCount || 0) > 0 ? 'ao-att-num--pend' : ''],
        ['Staff', s.totalTeachers || 0, ''],
      ].forEach(function (cell) {
        var box = el('div', 'ao-att-stat');
        box.appendChild(el('div', 'ao-att-num' + (cell[2] ? ' ' + cell[2] : ''), String(cell[1])));
        box.appendChild(el('div', 'ao-att-label', cell[0]));
        stats.appendChild(box);
      });
      body.appendChild(stats);

      if ((s.lateCount || 0) > 0) {
        body.appendChild(aoSection('Late today', s.lateCount, 'late'));
        var list = el('div', 'ao-rows');
        data.late.forEach(function (t) {
          var row = el('div', 'ao-row ao-row--static');
          row.appendChild(el('span', 'ao-row-main', t.name));
          row.appendChild(el('span', 'ao-pill ao-pill--late', t.lateMinutes + ' min late'));
          list.appendChild(row);
        });
        body.appendChild(list);
      } else {
        body.appendChild(el('div', 'ao-allclear', 'Nobody has been marked late today.'));
      }
    },

    activity: function (panel, body, data) {
      clearBody(body);
      if (!data.entries || data.entries.length === 0) {
        body.appendChild(el('div', 'ao-allclear', 'No audited activity recorded yet.'));
        return;
      }
      var ACTION_PILL = {
        create: 'paid', update: 'pending', deactivate: 'error',
        activate: 'paid', generate: 'partial', finalize: 'ocr',
      };
      data.entries.forEach(function (e) {
        var row = el('div', 'ao-activity-row');
        row.appendChild(el('span', 'ao-activity-time', relTime(e.timestamp)));
        // Same pill palette the audit viewer and admin panels use.
        var pill = el('span', 'pill ao-activity-pill ' + (ACTION_PILL[e.actionType] || 'pending'), e.actionType);
        row.appendChild(pill);
        row.appendChild(el('span', 'ao-activity-summary', e.summary));
        row.appendChild(el('span', 'ao-activity-user', e.userName + ' · ' + e.userRole));
        body.appendChild(row);
      });
    },
  };

  // ── independent panel loader ─────────────────────────────────────────────
  function loadPanel(panel) {
    var endpoint = panel.getAttribute('data-ao-endpoint');
    var kind = endpoint.split('/').pop();
    var body = panel.querySelector('.ao-body');
    if (!body || !RENDERERS[kind]) return Promise.resolve();

    clearBody(body);
    body.appendChild(el('div', 'ao-loading', 'Loading…'));

    return fetch(endpoint, { credentials: 'same-origin' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (payload) {
        if (!payload.ok) throw new Error(payload.error || 'Panel data could not be loaded');
        clearBody(body);
        RENDERERS[kind](panel, body, payload.data);
      })
      .catch(function (err) {
        clearBody(body);
        var box = el('div', 'ao-error');
        box.appendChild(el('span', 'ao-error-msg', err.message || 'Could not load this panel.'));
        var retry = el('button', 'btn btn-ghost ao-retry', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', function () { loadPanel(panel); });
        box.appendChild(retry);
        body.appendChild(box);
      });
  }

  function init() {
    var panels = document.querySelectorAll('[data-ao-endpoint]');
    // Fire every panel independently — Promise.all only groups the settled
    // results; a slow or failed panel never blocks the others' rendering.
    Promise.all(Array.prototype.map.call(panels, loadPanel));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
