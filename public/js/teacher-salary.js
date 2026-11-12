// Teacher salary runs page (Phase 2, admin only).
// 1. Teacher picker: shows the pay-config status pill ("Pay rate not set"
//    mirrors the Phase 1 expected-arrival pill), reveals the lecture-count
//    override for per-lecture teachers, and blocks preview/generate until a
//    rate exists (the API also fails closed — this is UX, not the gate).
// 2. Preview (dry run): POSTs to the admin-only view proxy, which calls the
//    API preview endpoint — zero writes. The save path recomputes server-side,
//    so nothing rendered here is ever trusted as an amount.
(function () {
  var teacherSel = document.getElementById('genTeacher');
  if (!teacherSel) return; // not the runs page

  var esc = window.escapeHtml;
  var statusEl = document.getElementById('teacherStatus');
  var lectureField = document.getElementById('lectureOverrideField');
  var previewBtn = document.getElementById('previewBtn');
  var generateBtn = document.getElementById('generateBtn');
  var previewPanel = document.getElementById('previewPanel');
  var previewBody = document.getElementById('previewBody');
  var previewRange = document.getElementById('previewRange');

  function fmtRs(n) {
    return 'Rs ' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // Dates arrive as ISO strings of LOCAL-midnight instants — format with the
  // local clock, never slice the UTC ISO string (off-by-one day trap).
  function localKey(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function selected() {
    return teacherSel.options[teacherSel.selectedIndex] || null;
  }

  function refreshTeacherState() {
    var opt = selected();
    var hasConfig = opt && opt.value && opt.getAttribute('data-hasconfig') === '1';
    var payType = opt ? opt.getAttribute('data-paytype') : '';
    var effectiveNow = opt && opt.getAttribute('data-effectivenow') === '1';

    if (!opt || !opt.value) {
      statusEl.innerHTML = 'Select a teacher to see their pay configuration.';
    } else if (!hasConfig) {
      statusEl.innerHTML = '<span class="pill review">Pay rate not set</span> ' +
        'Salary cannot be calculated for this teacher until a rate is configured. ' +
        '<a href="/teacher-salary/config">Set a pay rate</a>.';
    } else if (!effectiveNow) {
      statusEl.innerHTML = '<span class="pill review">Scheduled rate</span> ' +
        'The configured rate takes effect in the future — runs for earlier periods need a rate effective on or before the period start.';
    } else {
      statusEl.innerHTML = '<span class="pill paid">' + (payType === 'per-hour' ? 'Per hour' : 'Per lecture') + '</span> ' +
        'Pay rate configured.';
    }

    // Lecture override only makes sense for per-lecture teachers.
    lectureField.style.display = hasConfig && payType === 'per-lecture' ? '' : 'none';
    previewBtn.disabled = !hasConfig;
    generateBtn.disabled = !hasConfig;
  }

  teacherSel.addEventListener('change', refreshTeacherState);
  refreshTeacherState();

  // ── Preview rendering ────────────────────────────────────────────────────

  function renderPreview(data) {
    var html = '';

    // Warnings first — never let an incomplete day or an overlap pass silently.
    if (data.incompleteDays > 0) {
      html += '<div class="flash error">' + data.incompleteDays +
        ' day(s) have an arrival but no departure — counted as working days with 0 hours.</div>';
    }
    if (data.overlaps && data.overlaps.length > 0) {
      html += '<div class="flash error">This period overlaps ' + data.overlaps.length +
        ' finalized run(s): ' +
        data.overlaps.map(function (o) {
          return esc(localKey(o.periodStart) + ' → ' + localKey(o.periodEnd) + ' (' + fmtRs(o.netAmount) + ')');
        }).join(', ') +
        '. Saving creates a separate draft — review before finalizing.</div>';
    }
    if (data.replacesDraftId) {
      html += '<div class="flash ok">A draft already exists for this exact period — saving will replace it.</div>';
    }

    html += '<p style="margin:0 0 10px;"><strong>' + esc(data.teacher.name) + '</strong> · ' +
      esc(data.payType === 'per-hour' ? 'Per hour' : 'Per lecture') + ' · ' +
      data.totalWorkingDays + ' working day(s) · ' + data.totalWorkingHours + ' h · ' +
      data.lateDays + ' late day(s)</p>';

    if (data.payType === 'per-lecture') {
      html += '<p style="margin:0 0 10px; font-size:13px; color:var(--ink-soft);">Lectures: ' +
        data.lectureCount + (data.lectureOverridden ? ' (admin override; attendance default ' + data.lectureCountDefault + ')' : ' (= attended days)') + '</p>';
    }

    // Rate segments
    html += '<div class="table-wrap"><table class="ledger"><thead><tr>' +
      '<th>Effective from</th><th>Rate</th><th>Days</th><th>Hours</th>' +
      (data.payType === 'per-lecture' ? '<th>Lectures</th>' : '') +
      '<th>Amount</th></tr></thead><tbody>';
    (data.segments || []).forEach(function (s) {
      html += '<tr><td class="mono">' + esc(localKey(s.effectiveFrom)) + '</td>' +
        '<td class="mono">' + fmtRs(s.rateAmount) + (data.payType === 'per-hour' ? ' / h' : ' / lecture') + '</td>' +
        '<td class="mono">' + s.days + '</td><td class="mono">' + s.hours + '</td>' +
        (data.payType === 'per-lecture' ? '<td class="mono">' + s.lectures + '</td>' : '') +
        '<td class="num mono">' + fmtRs(s.amount) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    // Totals
    html += '<div class="stats" style="margin-top:12px;">' +
      '<div class="stat-card accent-blue"><div class="stat-value mono">' + fmtRs(data.grossAmount) + '</div><div class="stat-label">Gross</div></div>' +
      '<div class="stat-card accent-gold"><div class="stat-value mono">' + (data.lateDeductionAmount > 0 ? fmtRs(data.lateDeductionAmount) : '—') + '</div><div class="stat-label">Late deduction</div></div>' +
      '<div class="stat-card accent-green"><div class="stat-value mono">' + fmtRs(data.netAmount) + '</div><div class="stat-label">Net</div></div>' +
      '</div>';

    if (data.deductionRule && data.deductionRule.enabled && data.lateDeductionAmount === 0) {
      html += '<p style="font-size:13px; color:var(--ink-soft); margin:8px 0 0;">Deduction rule is enabled but nothing was deducted (no late days in range, or Phase 1 late detection is off).</p>';
    }

    // Day-wise rows (collapsible — the audit detail)
    if (data.days && data.days.length > 0) {
      html += '<details style="margin-top:10px;"><summary style="cursor:pointer; font-size:13px;">Day-wise attendance (' + data.days.length + ')</summary>' +
        '<div class="table-wrap" style="margin-top:8px;"><table class="ledger"><thead><tr>' +
        '<th>Date</th><th>Arrival</th><th>Departure</th><th>Minutes</th><th>Late</th></tr></thead><tbody>';
      data.days.forEach(function (d) {
        html += '<tr><td class="mono">' + esc(localKey(d.date)) + '</td>' +
          '<td class="mono">' + esc(d.arrivalTime) + '</td>' +
          '<td class="mono">' + esc(d.departureTime || '—') + '</td>' +
          '<td class="mono">' + d.workingMinutes + '</td>' +
          '<td>' + (d.isLate ? '<span class="pill review">Late</span>' : '<span class="pill paid">On time</span>') + '</td></tr>';
      });
      html += '</tbody></table></div></details>';
    }

    previewRange.textContent = localKey(data.periodStart) + ' → ' + localKey(data.periodEnd);
    previewBody.innerHTML = html;
    previewPanel.style.display = '';
    previewPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  previewBtn.addEventListener('click', function () {
    var opt = selected();
    if (!opt || !opt.value) {
      previewBody.innerHTML = '<div class="flash error">Select a teacher first.</div>';
      previewPanel.style.display = '';
      return;
    }
    previewBtn.disabled = true;
    previewBody.innerHTML = '<p style="color:var(--ink-soft);">Calculating…</p>';
    previewPanel.style.display = '';

    fetch('/teacher-salary/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.CSRF_TOKEN
      },
      body: JSON.stringify({
        teacherId: opt.value,
        startDate: document.getElementById('genStart').value,
        endDate: document.getElementById('genEnd').value,
        lectureCount: document.getElementById('genLectures').value
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (result.status === 'success') {
          renderPreview(result.data);
        } else {
          previewRange.textContent = '';
          previewBody.innerHTML = '<div class="flash error">' + esc(result.message || 'Preview failed') + '</div>';
        }
      })
      .catch(function () {
        previewRange.textContent = '';
        previewBody.innerHTML = '<div class="flash error">Preview request failed — please retry.</div>';
      })
      .finally(function () {
        refreshTeacherState(); // re-enable per config state
      });
  });
})();