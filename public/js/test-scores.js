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
  // The teacher can change the test's total marks on this page; reflect the
  // new ceiling on every score input and refresh the live percentages.
  function syncMaxToInputs() {
    const max = currentMax();
    if (max === null) return;
    document.querySelectorAll('.score-input').forEach(function (el) {
      // dataset (not setAttribute) — keeps the vm-based regression harnesses
      // with their minimal element stubs working.
      el.dataset.max = max;
    });
    // Percentages are relative to the total — refresh with the new ceiling.
    updatePercentages();
  }
  if (totalMarksInput) {
    totalMarksInput.addEventListener('input', syncMaxToInputs);
  }

  // ── Save total / pass marks WITHOUT reloading the page ────────────────
  // This used to be a POST form that redirected back here, which wiped every
  // score the teacher had typed but not yet saved. PATCH the scale through
  // the API instead (Bearer token from the head meta, CSRF-exempt — same
  // pattern as the OCR page) and update the roster in place.
  const settingsPanel = document.getElementById('test-settings');
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  const passMarksInput = document.getElementById('pass-marks-input');
  const settingsStatus = document.getElementById('settings-status');
  function setSettingsStatus(text, ok) {
    if (!settingsStatus) return;
    settingsStatus.textContent = text || '';
    settingsStatus.style.color = ok ? 'var(--ok)' : 'var(--error)';
  }
  function bearerAuth() {
    const meta = document.querySelector('meta[name="auth-token"]');
    return meta && meta.content ? { Authorization: 'Bearer ' + meta.content } : {};
  }
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', function () {
      const testId = settingsPanel && settingsPanel.dataset ? settingsPanel.dataset.testId : null;
      if (!testId) return;
      const total = Number(totalMarksInput && totalMarksInput.value);
      const pass = Number(passMarksInput && passMarksInput.value);
      // Guard a mistyped scale before the round-trip (server also enforces it).
      if (!Number.isFinite(total) || total < 1) {
        setSettingsStatus('Total marks must be at least 1.', false);
        return;
      }
      if (Number.isFinite(pass) && pass > total) {
        setSettingsStatus('Pass marks cannot exceed total marks.', false);
        return;
      }
      saveSettingsBtn.disabled = true;
      setSettingsStatus('Saving…', true);
      fetch('/api/v1/tests/' + testId + '/marks', {
        method: 'PATCH',
        headers: Object.assign({ 'Content-Type': 'application/json' }, bearerAuth()),
        body: JSON.stringify({ totalMarks: total, passMarks: pass }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.status === 'success') {
            // New ceiling is live — re-flag any score now above it and refresh %.
            syncMaxToInputs();
            setSettingsStatus('Saved.', true);
          } else {
            setSettingsStatus((data && data.message) || 'Save failed.', false);
          }
        })
        .catch(function () { setSettingsStatus('Save failed.', false); })
        .finally(function () { saveSettingsBtn.disabled = false; });
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

  // ── Search students (filter rows by name or roll number) ─────────────
  // Client-side only: hides non-matching rows so the teacher can jump to a
  // pupil in a long roster. Hidden rows keep their inputs in the DOM, so the
  // save step (which re-queries every data-student row) still commits marks
  // entered before the teacher refined the search.
  const searchInput = document.getElementById('search-student');
  const noMatchRow = document.getElementById('roster-no-match');
  function applyStudentSearch() {
    const q = (searchInput.value || '').trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll('#roster-body tr[data-student]').forEach(function (row) {
      const hay = (row.dataset.name || '') + ' ' + (row.dataset.roll || '');
      const show = !q || hay.indexOf(q) !== -1;
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    if (noMatchRow) noMatchRow.style.display = (q && visible === 0) ? '' : 'none';
  }
  if (searchInput) {
    searchInput.addEventListener('input', applyStudentSearch);
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      const records = [];
      let absentCount = 0;
      // Re-query rows from the DOM so we pick up the current (possibly sorted)
      // order. Only real roster rows carry data-student — this skips the
      // "no match" placeholder row and binds each score to the right pupil.
      const currentRows = document.querySelectorAll('#roster-body tr[data-student]');
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
