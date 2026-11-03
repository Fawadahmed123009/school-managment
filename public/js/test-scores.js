(function () {
  const enteredCount = document.getElementById('entered-count');
  const saveBtn = document.getElementById('save-scores-btn');
  // Declared up-front with the other elements the status helpers anchor to —
  // reading them later inside setScoresStatus would put them in their temporal
  // dead zone for any call made during load (the TDZ class of bug that once
  // silently killed this whole script and left the Save button dead).
  const scoresForm = document.getElementById('scores-form');
  const recordsInput = document.getElementById('records-input');

  // Inline status next to the Save button. Replaces the old blocking
  // alert()/confirm() flow, which can be a silent no-op inside the installed
  // PWA (prod HTTPS only) — there a suppressed dialog made "Save scores" look
  // dead. Status is shown in the page instead, so feedback never disappears.
  let scoresStatus = document.getElementById('scores-status');
  function setScoresStatus(text, ok) {
    if (!scoresStatus) {
      // An old cached page without the status element would otherwise swallow
      // every failure message — the save would again look dead. Append one.
      try {
        scoresStatus = document.createElement('span');
        scoresStatus.id = 'scores-status';
        (scoresForm || document.body).appendChild(scoresStatus);
      } catch (err) {
        return; // genuinely nowhere to put it; the save still proceeds
      }
    }
    scoresStatus.textContent = text || '';
    scoresStatus.style.color = ok ? 'var(--ok)' : 'var(--error)';
  }

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
  let settingsStatus = document.getElementById('settings-status');
  function setSettingsStatus(text, ok) {
    if (!settingsStatus) {
      try {
        settingsStatus = document.createElement('span');
        settingsStatus.id = 'settings-status';
        (settingsPanel || document.body).appendChild(settingsStatus);
      } catch (err) {
        return;
      }
    }
    settingsStatus.textContent = text || '';
    settingsStatus.style.color = ok ? 'var(--ok)' : 'var(--error)';
  }
  function bearerAuth() {
    const meta = document.querySelector('meta[name="auth-token"]');
    return meta && meta.content ? { Authorization: 'Bearer ' + meta.content } : {};
  }

  // Read an API response whatever it contains. JSON is the normal case; a
  // non-JSON body means the request never reached the API (an expired session
  // redirected to the login page, a proxy error page, an offline mobile
  // connection). Reporting the HTTP status/shape is what turns a bare
  // "Save failed." into something the teacher can act on.
  function readApiResponse(res) {
    return res.text().then(function (text) {
      try {
        return { payload: JSON.parse(text), status: res.status };
      } catch (err) {
        return { nonJson: true, status: res.status, redirected: res.redirected, body: text };
      }
    });
  }

  function describeApiResponse(r) {
    if (r.nonJson) {
      if (!r.status) return 'No response from the server — check the connection and try again.';
      if (r.redirected) return 'Your session expired — sign in again, then reload this page.';
      return 'The server replied with an unexpected page (HTTP ' + r.status + '). Please try again.';
    }
    if (r.payload && r.payload.message) return r.payload.message;
    if (r.status === 401) return 'Your session is no longer valid — sign in again and retry.';
    if (r.status === 403) return 'You are not allowed to change this test’s marks scale.';
    if (r.status === 404) return 'This test no longer exists — reload the page.';
    if (r.status >= 500) return 'Server error (HTTP ' + r.status + ') — please try again in a moment.';
    return 'Save failed (HTTP ' + r.status + ').';
  }
  // A number input hands back an empty string when the teacher clears the box,
  // and Number('') is 0 — which would silently save "no pass threshold" (or a
  // 0-mark test) instead of complaining. Blank is read as NaN so the guards below
  // refuse it exactly like the service does, and nothing is POSTed as null.
  function readScale(input) {
    const raw = String((input && input.value) || '').trim();
    return raw === '' ? NaN : Number(raw);
  }

  // Errors we phrase for the teacher are marked, so the network catch below can
  // tell them apart from a raw engine message such as Chrome's "Failed to fetch".
  function friendlyError(message) {
    const err = new Error(message);
    err.friendly = true;
    return err;
  }

  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', function () {
      const testId = settingsPanel && settingsPanel.dataset ? settingsPanel.dataset.testId : null;
      if (!testId) return;
      const total = readScale(totalMarksInput);
      const pass = readScale(passMarksInput);
      // Guard a mistyped scale before the round-trip (server also enforces it).
      // A cleared field is refused here rather than sent as NaN — JSON would
      // serialise that to null, which the server reads as "no value".
      if (!Number.isFinite(total) || total < 1) {
        setSettingsStatus('Total marks is required — enter a number of at least 1.', false);
        return;
      }
      if (!Number.isFinite(pass) || pass < 0) {
        setSettingsStatus('Pass marks is required — enter 0 when there is no pass threshold.', false);
        return;
      }
      if (pass > total) {
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
        .then(readApiResponse)
        .then(function (r) {
          if (r.nonJson || !r.payload || r.payload.status !== 'success') {
            throw friendlyError(describeApiResponse(r));
          }
          // New ceiling is live — re-flag any score now above it and refresh %.
          syncMaxToInputs();
          setSettingsStatus('Saved.', true);
        })
        // A rejected fetch = the request never got an answer (offline mobile data,
        // DNS, a dropped connection). Report it as a connection problem rather than
        // echoing the engine's terse text, which the teacher cannot act on.
        .catch(function (err) {
          const msg = err && err.friendly
            ? err.message
            : 'No response from the server — check the connection and try again.';
          setSettingsStatus(msg, false);
        })
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

  // ── Save scores ────────────────────────────────────────────────────────
  const SAVE_LABEL = (saveBtn && saveBtn.textContent) || 'Save scores';

  function restoreSaveBtn() {
    if (!saveBtn) return;
    saveBtn.disabled = false;
    saveBtn.textContent = SAVE_LABEL;
  }

  // A slow or interrupted POST on a phone normally ends with the browser
  // restoring this page from the back/forward cache. Nothing used to re-arm the
  // button there: it stayed disabled with the label "Saving…", and a disabled
  // button fires no click at all — so the teacher's next Save press did nothing
  // ("the button stopped responding"). bfcache use varies by browser, which is
  // why only some devices hit it. Restoring state on pageshow closes that gap.
  if (window.addEventListener) {
    window.addEventListener('pageshow', function (e) {
      if (e && e.persisted) {
        restoreSaveBtn();
        setScoresStatus('');
      }
    });
  }

  if (scoresForm) {
    // Enter must not submit this form. An empty box is an ABSENCE by design, so
    // an implicit submit while moving between boxes would save the whole class
    // as absent. Enter is consumed; on a score box it advances focus instead,
    // which is what the teacher was actually trying to do.
    scoresForm.addEventListener('keydown', function (e) {
      e = e || {};
      const key = e.key || (e.keyCode === 13 ? 'Enter' : '');
      if (key !== 'Enter') return;
      const tag = ((e.target && e.target.tagName) || '').toUpperCase();
      if (tag === 'TEXTAREA') return;
      if (e.preventDefault) e.preventDefault(); else e.returnValue = false;
      if (tag !== 'INPUT') return;
      const boxes = Array.prototype.slice.call(document.querySelectorAll('.score-input'));
      const next = boxes[boxes.indexOf(e.target) + 1];
      if (next && next.focus) next.focus();
    });

    // Serialization runs on the FORM's submit event, not on a button click: the
    // button is a native submit control, so a page whose script never ran still
    // posts (and the server answers with a readable flash) instead of sitting
    // dead. Healthy script fills #records-input here, or cancels the submission
    // with an inline reason.
    scoresForm.addEventListener('submit', function (e) {
      e = e || {};
      const cancel = function () {
        if (e.preventDefault) e.preventDefault(); else e.returnValue = false;
        restoreSaveBtn();
      };
      // The whole handler is guarded: a stray throw must not leave the button
      // disabled on "Saving…" with nothing submitted. Any failure re-arms it and
      // reports inline instead.
      try {
        if (!recordsInput) {
          setScoresStatus('Save failed — the form is missing. Please reload the page.', false);
          cancel();
          return;
        }

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
          if (!input) return; // no box on this row → nothing to record
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
        // silently turn it into null = absence). Reported inline, NOT via
        // alert(): a blocking dialog can be a silent no-op inside the installed
        // PWA, which would make the Save button appear dead.
        if (invalid.length > 0) {
          setScoresStatus('Each box must be a number or "A" (absent). Fix: ' + invalid.slice(0, 5).join(', ') + (invalid.length > 5 ? '…' : ''), false);
          cancel();
          return;
        }

        if (records.length === 0) {
          setScoresStatus('No pupils to save — the roster is empty.', false);
          cancel();
          return;
        }

        // Front-end guard so a stale row value above a just-edited total gives a
        // readable message instead of a round-trip rejection from the API.
        const max = currentMax();
        if (max !== null) {
          const over = records.filter(function (r) { return r.score !== null && r.score > max; });
          if (over.length > 0) {
            setScoresStatus('Scores must be between 0 and ' + max + '. Adjust ' + over.length + ' entered value(s) (or save the new total marks first).', false);
            cancel();
            return;
          }
        }

        // Absences are committed directly — a blank box or "A" saves as Absent
        // (A). There is deliberately NO blocking confirm() here any more: inside
        // the installed PWA / an in-app WebView window.confirm can be a silent
        // no-op that returns false, so gating the save on it meant clicking Save
        // did nothing. The inline note just informs the teacher of the count.
        recordsInput.value = JSON.stringify(records);
        if (absentCount > 0) setScoresStatus(absentCount + ' pupil(s) will be saved as Absent (A).', true);
        if (saveBtn) saveBtn.textContent = 'Saving…';
        // No preventDefault and no manual form.submit(): the browser performs the
        // POST, so the global double-submit lock (js/confirm-submit.js) applies
        // and its pageshow handler re-enables this button after a bfcache return.
      } catch (err) {
        cancel();
        setScoresStatus('Could not save the scores. Please reload the page and try again.', false);
      }
    });
  }
})();
