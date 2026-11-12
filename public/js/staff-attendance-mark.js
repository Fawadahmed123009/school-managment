// Teacher (staff) attendance marking — review & correction of the times
// auto-captured from teacher logins, plus manual entry. Live working-hours +
// late preview, then a single form POST carrying every touched row as JSON
// (same pattern as attendance-mark.js). A row may send just ONE time: the
// server merges the other from what login/logout already captured.
(function () {
  const rows = document.querySelectorAll('#ta-roster tbody tr');
  const saveBtn = document.getElementById('save-attendance-btn');
  const datePicker = document.getElementById('date-picker');

  // Late rule comes from a non-executed JSON island (CSP-safe).
  let settings = { lateDetectionEnabled: false, startTime: '08:00', graceMinutes: 5 };
  const island = document.getElementById('ta-settings');
  if (island) {
    try { settings = JSON.parse(island.textContent); } catch (e) { /* keep defaults */ }
  }

  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  function toMinutes(str) {
    if (!TIME_RE.test(str || '')) return NaN;
    const parts = str.split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  function fmtMinutes(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm';
  }

  function pill(className, text) {
    const span = document.createElement('span');
    span.className = 'pill ' + className;
    span.textContent = text;
    return span;
  }

  // Recompute one row's working-hours + late preview from its inputs.
  function refreshRow(row) {
    const arrival = row.querySelector('.ta-arrival').value;
    const departure = row.querySelector('.ta-departure').value;
    const hoursCell = row.querySelector('.ta-hours');
    const lateCell = row.querySelector('.ta-late');

    const a = toMinutes(arrival);
    const d = toMinutes(departure);

    // Late preview depends on the arrival alone (login-captured rows may
    // not have a departure yet). The threshold is the teacher's OWN expected
    // arrival time (row dataset, from the staff profile) + the grace period;
    // no expected time → the check is skipped, exactly like the server.
    lateCell.textContent = '';
    if (!Number.isNaN(a)) {
      if (!settings.lateDetectionEnabled) {
        lateCell.appendChild(pill('paid', 'On time'));
      } else {
        const expected = toMinutes(row.dataset.expected);
        if (Number.isNaN(expected)) {
          const skip = pill('', 'not checked');
          skip.title = 'No expected arrival time set on this teacher\'s staff profile';
          lateCell.appendChild(skip);
        } else {
          const over = a - (expected + (Number(settings.graceMinutes) || 0));
          if (over > 0) lateCell.appendChild(pill('review', 'Late +' + over + 'm'));
          else lateCell.appendChild(pill('paid', 'On time'));
        }
      }
    }

    if (Number.isNaN(a) || Number.isNaN(d)) {
      hoursCell.textContent = '—';
      return;
    }
    if (d <= a) {
      hoursCell.textContent = '—';
      lateCell.textContent = '';
      lateCell.appendChild(pill('error', 'Departure before arrival'));
      return;
    }
    hoursCell.textContent = fmtMinutes(d - a);
  }

  rows.forEach((row) => {
    row.querySelectorAll('input[type="time"]').forEach((input) => {
      input.addEventListener('input', () => {
        // Editing a flagged time clears its inline error (M1).
        FormFeedback.clearFieldError(input);
        refreshRow(row);
      });
    });
  });

  // ── Save: collect every row with at least one time entered ──
  // Single-field rows are corrections of auto-captured times; the server
  // merges the untouched side from the existing record.
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const records = [];
      const invalid = [];

      rows.forEach((row) => {
        const arrival = row.querySelector('.ta-arrival').value;
        const departure = row.querySelector('.ta-departure').value;
        if (!arrival && !departure) return; // untouched row — skip
        const a = toMinutes(arrival);
        const d = toMinutes(departure);
        if (arrival && departure && (Number.isNaN(a) || Number.isNaN(d) || d <= a)) {
          invalid.push(row.dataset.name || 'a teacher');
          return;
        }
        records.push({ teacher: row.dataset.teacher, arrivalTime: arrival, departureTime: departure });
      });

      if (invalid.length > 0) {
        // Inline on the offending departure inputs + a toast naming the rows —
        // alert() can be silently suppressed in the installed PWA (M1).
        rows.forEach((row) => {
          const dep = row.querySelector('.ta-departure');
          const arr = row.querySelector('.ta-arrival').value;
          const dept = dep.value;
          if (arr && dept) {
            const a = toMinutes(arr);
            const d = toMinutes(dept);
            if (Number.isNaN(a) || Number.isNaN(d) || d <= a) {
              FormFeedback.setFieldError(dep, 'Departure must be after arrival.');
            }
          }
        });
        Toast.error('Departure must be after arrival for: ' + invalid.join(', '), { title: 'Check the times' });
        return;
      }
      if (records.length === 0) {
        Toast.warning('Enter or correct at least one time before saving.', { title: 'Nothing to save' });
        return;
      }

      document.getElementById('records-input').value = JSON.stringify(records);
      // form.submit() fires no submit event, so the global double-submit
      // guard never sees it — lock the button ourselves (M2), with bfcache
      // restore so Back never lands on a dead "Saving…" button.
      FormFeedback.busy(saveBtn, 'Saving…');
      document.getElementById('ta-form').submit();
    });
  }

  // Date navigation: reload the roster for the chosen date.
  if (datePicker) {
    datePicker.addEventListener('change', function () {
      const base = datePicker.dataset.markBase;
      if (base && this.value) window.location.href = base + '?date=' + this.value;
    });
  }
})();