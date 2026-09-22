(function () {
  const rows = document.querySelectorAll('#roster-body tr');
  const enteredCount = document.getElementById('entered-count');
  const saveBtn = document.getElementById('save-scores-btn');

  function updateCount() {
    let count = 0;
    document.querySelectorAll('.score-input').forEach(function (el) {
      if (el.value !== '') count++;
    });
    if (enteredCount) enteredCount.textContent = count;
  }

  document.querySelectorAll('.score-input').forEach(function (el) {
    el.addEventListener('input', updateCount);
  });
  updateCount();

  // ── Keep score inputs in sync with the editable total-marks field ─────
  // The teacher can change the test's total marks on this page; before the
  // save-and-redirect lands, reflect the new ceiling on every score input.
  const totalMarksInput = document.getElementById('total-marks-input');
  function currentMax() {
    const n = Number(totalMarksInput && totalMarksInput.value);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }
  if (totalMarksInput) {
    totalMarksInput.addEventListener('input', function () {
      const max = currentMax();
      if (max === null) return;
      document.querySelectorAll('.score-input').forEach(function (el) {
        el.max = max;
      });
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
      // Re-query rows from the DOM so we pick up the current (possibly sorted) order.
      // Each row carries data-student, so score→student binding is per-row, not positional.
      const currentRows = document.querySelectorAll('#roster-body tr');
      currentRows.forEach(function (row) {
        const studentId = row.dataset.student;
        const input = row.querySelector('.score-input');
        if (input.value !== '') {
          records.push({ student: studentId, score: Number(input.value) });
        }
      });

      if (records.length === 0) {
        alert('Enter at least one score before saving.');
        return;
      }

      // Front-end guard so a stale row value above a just-edited total gives a
      // readable message instead of a round-trip rejection from the API.
      const max = currentMax();
      if (max !== null) {
        const over = records.filter(function (r) { return r.score > max; });
        if (over.length > 0) {
          alert('Scores must be between 0 and ' + max + '. Adjust ' + over.length + ' entered value(s) (or save the new total marks first).');
          return;
        }
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      document.getElementById('records-input').value = JSON.stringify(records);
      document.getElementById('scores-form').submit();
    });
  }
})();
