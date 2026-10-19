(function () {
  const enteredCount = document.getElementById('entered-count');
  const saveBtn = document.getElementById('save-scores-btn');

  // ── Editable total marks (must be declared BEFORE any currentMax() use) ──
  // Regression note: calling updatePercentages()/currentMax() before this
  // const binding initializes throws a TDZ ReferenceError at load, silently
  // killing the whole script — the Save-scores listener never attaches and
  // the button stops doing anything.
  const totalMarksInput = document.getElementById('total-marks-input');
  function currentMax() {
    const n = Number(totalMarksInput && totalMarksInput.value);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }

  function updateCount() {
    let count = 0;
    document.querySelectorAll('.score-input').forEach(function (el) {
      if (el.value !== '') count++;
    });
    if (enteredCount) enteredCount.textContent = count;
  }

  // An empty box or a literal "A"/"a" is an ABSENCE marker; anything else must
  // parse as a number (a typed 0 is a genuine score, shown "0" and counted in
  // every average — only absences are excluded).
  function absentToken(v) {
    const t = (v || '').trim();
    return t === '' || t.toLowerCase() === 'a';
  }

  // ── Live percentage (score / current total marks) ────────────────────
  // Each row's % cell refreshes as the teacher types, so the ratio is
  // always visible next to the raw score before anything is saved.
  function updatePercentages() {
    const max = currentMax();
    document.querySelectorAll('#roster-body tr').forEach(function (row) {
      const input = row.querySelector('.score-input');
      const cell = row.querySelector('.pct-cell');
      if (!input || !cell) return;
      const v = Number(input.value);
      cell.textContent = (input.value !== '' && max && v <= max)
        ? (Math.round((v / max) * 1000) / 10) + '%'
        : '';
    });
  }

  document.querySelectorAll('.score-input').forEach(function (el) {
    el.addEventListener('input', function () { updateCount(); updatePercentages(); });
  });
  updateCount();
  updatePercentages();

  // ── Keep score inputs in sync with the editable total-marks field ─────
  // The teacher can change the test's total marks on this page; before the
  // save-and-redirect lands, reflect the new ceiling on every score input.
  if (totalMarksInput) {
    totalMarksInput.addEventListener('input', function () {
      const max = currentMax();
      if (max === null) return;
      document.querySelectorAll('.score-input').forEach(function (el) {
        // dataset (not setAttribute) — keeps the vm-based regression harnesses
        // with their minimal element stubs working.
        el.dataset.max = max;
      });
      // Percentages are relative to the total — refresh with the new ceiling.
      updatePercentages();
    });
  }

  // ── Sort by roll number (re-orders DOM rows) ──────────────────────────
  const sortRoll = document.getElementById('sort-roll');
  if (sortRoll) {
    sortRoll.addEventListener('change', function () {
      const tbody = document.getElementById('roster-body');
      const allRows = Array.from(tbody.querySelectorAll('tr'));
      const val = this.value;
      if (!val) return; // default order — no re-sort
      allRows.sort(function (a, b) {
        const ra = (a.dataset.roll || '').trim();
        const rb = (b.dataset.roll || '').trim();
        const cmp = ra.localeCompare(rb, undefined, { numeric: true });
        return val === 'rollAsc' ? cmp : -cmp;
      });
      allRows.forEach(function (row) { tbody.appendChild(row); });
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      const records = [];
      let absentCount = 0;
      // Re-query rows from the DOM so we pick up the current (possibly sorted) order.
      // Each row carries data-student, so score→student binding is per-row, not positional.
      const currentRows = document.querySelectorAll('#roster-body tr');
      const invalid = [];
      currentRows.forEach(function (row) {
        const studentId = row.dataset.student;
        const input = row.querySelector('.score-input');
        const v = (input.value || '').trim();
        if (absentToken(v)) {
          // Blank box or typed "A" → the pupil was ABSENT for this test. Send
          // null so the server records an absence (shown as "A", excluded from
          // average) instead of silently dropping the row as "unmarked".
          absentCount++;
          records.push({ student: studentId, score: null });
        } else if (!Number.isFinite(Number(v)) || v === '' || Number(v) < 0) {
          invalid.push(row.querySelector('td strong') ? row.querySelector('td strong').textContent : studentId);
        } else {
          records.push({ student: studentId, score: Number(v) });
        }
      });

      // Text inputs accept anything — catch stray text before it becomes a
      // NaN/absent surprise on the server (Number('x') is NaN, and JSON would
      // silently turn it into null = absence).
      if (invalid.length > 0) {
        alert('Each box must be a number or "A" (absent). Fix: ' + invalid.slice(0, 5).join(', ') + (invalid.length > 5 ? '…' : ''));
        return;
      }

      if (records.length === 0) {
        alert('No pupils to save — the roster is empty.');
        return;
      }

      // Front-end guard so a stale row value above a just-edited total gives a
      // readable message instead of a round-trip rejection from the API.
      const max = currentMax();
      if (max !== null) {
        const over = records.filter(function (r) { return r.score !== null && r.score > max; });
        if (over.length > 0) {
          alert('Scores must be between 0 and ' + max + '. Adjust ' + over.length + ' entered value(s) (or save the new total marks first).');
          return;
        }
      }

      // Make the automatic absence explicit before committing — a blank box or
      // a typed "A" is saved as Absent (A), so the teacher confirms that's
      // intended. A typed 0 is NOT here — it saves as a real 0.
      if (absentCount > 0 &&
        !confirm(absentCount + ' pupil(s) marked blank/"A" will be saved as Absent (A) and excluded from the class average. Continue?')) {
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      document.getElementById('records-input').value = JSON.stringify(records);
      document.getElementById('scores-form').submit();
    });
  }
})();
