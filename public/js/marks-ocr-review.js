(function () {
  // Initial pool from the page; replaced by the test-scoped candidates the
  // extract response returns, so dropdowns only list the selected class/section.
  let students = (function () {
    const el = document.getElementById('marks-ocr-students');
    if (el) { try { return JSON.parse(el.textContent); } catch (e) {} }
    return window.__STUDENTS__ || [];
  })();
  const pickBtn = document.getElementById('pick-photo-btn');
  const fileInput = document.getElementById('photo-input');
  const uploadStep = document.getElementById('upload-step');
  const reviewStep = document.getElementById('review-step');
  const sourcePreview = document.getElementById('source-preview');
  const rowsBody = document.getElementById('rows-body');
  const rowCount = document.getElementById('row-count');
  const rowTotal = document.getElementById('row-total');
  const saveBtn = document.getElementById('save-btn');
  const rescanBtn = document.getElementById('rescan-btn');

  let currentRows = [];
  let testId = '';
  // Ceiling for the live percentage column — set from the extract response
  // (the test's totalMarks) and kept in sync with the "Test settings" input.
  let ocrTotalMarks = null;

  pickBtn.addEventListener('click', () => {
    // Use window.selectedTestId set by the cascade script in ocr.ejs
    if (!window.selectedTestId) {
      alert('Select a test first.');
      return;
    }
    testId = window.selectedTestId;
    loadArchivedScan(); // fetch in the background while the picker is open
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    // Camera capture fires this handler without the picker click, so resolve
    // the chosen test here too — extraction requires one for roster scoping.
    testId = window.selectedTestId || testId;
    if (!testId) {
      alert('Select a test first.');
      return;
    }

    sourcePreview.src = URL.createObjectURL(file);

    const formData = new FormData();
    formData.append('image', file);
    formData.append('testId', testId);

    uploadStep.style.display = 'none';
    reviewStep.style.display = 'block';
    rowsBody.innerHTML = '<tr><td colspan="7">Extracting…</td></tr>';

    const res = await fetch('/marks/ocr/extract', { method: 'POST', headers: { 'X-CSRF-Token': window.CSRF_TOKEN }, body: formData });
    const data = await res.json();

    if (data.status !== 'success') {
      rowsBody.innerHTML = `<tr><td colspan="7">Error: ${window.escapeHtml(data.message)}</td></tr>`;
      return;
    }

    if (data.totalMarks) ocrTotalMarks = Number(data.totalMarks);

    // Scope the candidate pool (dropdowns + recommended matches) to the
    // students of the selected test's class/section returned by the server.
    if (Array.isArray(data.students)) students = data.students;

    // If the pre-fetch didn't run (e.g. camera capture), fetch the archived
    // copy now; the blob stays as fallback if archiving failed server-side.
    if (!archivedBlobUrl && data.archivedUrl) {
      pendingArchivedUrl = data.archivedUrl;
      loadArchivedScan();
    }

    currentRows = data.data;
    renderRows();
  });

  // Scans are archived in the cloud (marks-scans/); point the review preview
  // at the persisted copy via the auth-gated viewer.
  let pendingArchivedUrl = '';
  let archivedBlobUrl = '';

  function loadArchivedScan() {
    if (!pendingArchivedUrl) return;
    const url = '/marks/ocr/scan?url=' + encodeURIComponent(pendingArchivedUrl);
    fetch(url)
      .then(r => (r.ok ? r.blob() : Promise.reject()))
      .then(b => {
        if (archivedBlobUrl) URL.revokeObjectURL(archivedBlobUrl);
        archivedBlobUrl = URL.createObjectURL(b);
        sourcePreview.src = archivedBlobUrl;
      })
      .catch(() => { /* keep local blob preview */ });
  }

  // Parent name for a student in the candidate pool — the linked Parent
  // record when present, otherwise the student's fatherName field.
  function parentLabel(s) {
    if (!s) return '';
    return (s.parent && s.parent.name) || s.fatherName || '';
  }

  // Mirror of utils/fuzzyMatch normalizeRoll (kept minimal for the browser) —
  // used to flag sheet/record roll mismatches in the review grid.
  function normalizeRoll(roll) {
    const s = String(roll ?? "").toLowerCase().replace(/roll\s*(no\.?|number\.?)?|[\s._#-]+/g, "");
    return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
  }

  function renderRows() {
    if (!students.length) {
      rowsBody.innerHTML = '<tr><td colspan="7" style="color:var(--error)">No students loaded. Make sure students exist in the system, then reload this page.</td></tr>';
      rowCount.textContent = '0 rows';
      saveBtn.disabled = true;
      return;
    }
    saveBtn.disabled = false;
    rowCount.textContent = `${currentRows.length} rows`;
    rowsBody.innerHTML = currentRows.map((row, i) => {
      const esc = window.escapeHtml;
      const matchedStudent = students.find(s => s._id === row.studentId);
      const rollDisplay = matchedStudent && matchedStudent.rollNumber ? matchedStudent.rollNumber : '';
      // Roll as read from the scanned sheet — shown next to the record roll so
      // a mismatch is visible at a glance (the teacher fixes the selection).
      const sheetRoll = row.rollNo != null ? String(row.rollNo).trim() : '';
      const rollMismatch = matchedStudent && sheetRoll && normalizeRoll(sheetRoll) !== normalizeRoll(matchedStudent.rollNumber);
      const parentDisplay = matchedStudent ? parentLabel(matchedStudent) : '';
      const options = students.map(s => {
        const cls = s.classLevel ? s.classLevel.name : '';
        const roll = s.rollNumber != null ? `Roll #${s.rollNumber}` : '';
        // Parent name in the option label too — disambiguates same-name
        // students before a row selection is made (linked parent, else father).
        const pn = parentLabel(s);
        const parts = [cls, roll, pn ? 'Parent: ' + pn : ''].filter(Boolean).join(' · ');
        const label = parts ? `${s.name} — ${parts}` : s.name;
        return `<option value="${esc(s._id)}" ${row.studentId === s._id ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('');
      return `
        <tr data-row="${i}" data-roll="${esc(rollDisplay)}">
          <td><span class="dot ${esc(row.confidence)}"></span> ${esc(row.confidence)}</td>
          <td>
            <select class="student-select" data-row="${i}">
              <option value="">${esc(row.name || '(unreadable)')}${sheetRoll ? ' · Roll #' + esc(sheetRoll) : ''} — select student</option>
              ${options}
            </select>
            <div class="parent-cell" data-row="${i}" style="font-size:11px;color:var(--ink-soft);margin-top:2px;">${parentDisplay ? 'Parent: ' + esc(parentDisplay) : ''}</div>
          </td>
          <td><span class="mono roll-cell" style="color:var(--ink-soft);font-size:12px;">${rollDisplay ? '#' + esc(rollDisplay) : ''}</span></td>
          <td><span class="mono sheet-roll-cell" data-roll="${esc(sheetRoll)}" style="font-size:12px;${rollMismatch ? 'color:var(--error);font-weight:600;' : 'color:var(--ink-soft);'}" title="${rollMismatch ? 'Roll on the sheet does not match the selected student' : 'Roll read from the sheet'}">${sheetRoll ? esc(sheetRoll) : ''}</span></td>
          <td class="num"><input type="number" class="score-input" data-row="${i}" value="${esc(row.score ?? '')}" placeholder="Absent (A)" /></td>
          <td class="num"><span class="pct-cell mono" style="color:var(--ink-soft);font-size:12px;"></span></td>
          <td><button type="button" class="btn btn-ghost skip-btn" data-row="${i}">Skip</button></td>
        </tr>
      `;
    }).join('');
    updateTotal();
    attachRowEvents();
    updatePercentages();
  }

  // ── Live percentage (score / test total marks) ────────────────────────
  function currentOcrMax() {
    // Prefer the in-page "Test settings" field so the % follows edits to the
    // total; fall back to the totalMarks returned by the extract call.
    const el = document.getElementById('ocr-total-marks');
    const n = Number(el && el.value ? el.value : ocrTotalMarks);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }

  function updatePercentages() {
    const max = currentOcrMax();
    document.querySelectorAll('#rows-body tr').forEach(function (row) {
      const input = row.querySelector('.score-input');
      const cell = row.querySelector('.pct-cell');
      if (!input || !cell) return;
      const v = Number(input.value);
      cell.textContent = (input.value !== '' && max && v <= max)
        ? (Math.round((v / max) * 1000) / 10) + '%'
        : '';
    });
  }

  function attachRowEvents() {
    document.querySelectorAll('.score-input').forEach(el => el.addEventListener('input', function () { updateTotal(); updatePercentages(); }));
    // Update roll # and parent columns when user changes the student dropdown
    document.querySelectorAll('.student-select').forEach(sel => {
      sel.addEventListener('change', function () {
        const tr = this.closest('tr');
        const chosen = students.find(s => s._id === this.value);
        const roll = chosen && chosen.rollNumber ? chosen.rollNumber : '';
        tr.dataset.roll = roll;
        const rollCell = tr.querySelector('.roll-cell');
        if (rollCell) rollCell.innerHTML = roll ? `<span class="mono" style="color:var(--ink-soft);font-size:12px;">#${window.escapeHtml(roll)}</span>` : '';
        // Re-flag the sheet-roll cell when it stops/starts matching the choice
        const sheetCell = tr.querySelector('.sheet-roll-cell');
        if (sheetCell && sheetCell.dataset.roll) {
          const mismatch = roll && normalizeRoll(sheetCell.dataset.roll) !== normalizeRoll(roll);
          sheetCell.style.color = mismatch ? 'var(--error)' : 'var(--ink-soft)';
          sheetCell.style.fontWeight = mismatch ? '600' : '400';
          sheetCell.title = mismatch ? 'Roll on the sheet does not match the selected student' : 'Roll read from the sheet';
        }
        const parentCell = tr.querySelector('.parent-cell');
        if (parentCell) {
          const pn = chosen ? parentLabel(chosen) : '';
          parentCell.textContent = pn ? 'Parent: ' + pn : '';
        }
      });
    });
    document.querySelectorAll('.skip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.row);
        currentRows.splice(i, 1);
        renderRows();
      });
    });
  }

  // ── Sort by roll number (re-orders DOM rows) ──────────────────────────
  const sortRollOcr = document.getElementById('sort-roll-ocr');
  if (sortRollOcr) {
    sortRollOcr.addEventListener('change', function () {
      const tbody = document.getElementById('rows-body');
      const allRows = Array.from(tbody.querySelectorAll('tr'));
      const val = this.value;
      if (!val) return;
      allRows.sort(function (a, b) {
        const ra = (a.dataset.roll || '').trim();
        const rb = (b.dataset.roll || '').trim();
        const cmp = ra.localeCompare(rb, undefined, { numeric: true });
        return val === 'rollAsc' ? cmp : -cmp;
      });
      allRows.forEach(function (row) { tbody.appendChild(row); });
    });
  }

  function updateTotal() {
    let count = 0;
    document.querySelectorAll('.score-input').forEach(el => {
      if (el.value !== '') count++;
    });
    rowTotal.textContent = count;
  }

  // Keep the % column in sync when the teacher edits the test's total marks
  // in the "Test settings" panel above the reviewer.
  const ocrTotalMarksInput = document.getElementById('ocr-total-marks');
  if (ocrTotalMarksInput) {
    ocrTotalMarksInput.addEventListener('input', updatePercentages);
  }

  rescanBtn.addEventListener('click', () => {
    reviewStep.style.display = 'none';
    uploadStep.style.display = 'block';
    fileInput.value = '';
    currentRows = [];
  });

  saveBtn.addEventListener('click', async () => {
    const selects = document.querySelectorAll('.student-select');
    const scores = document.querySelectorAll('.score-input');
    const records = [];
    let missingStudent = 0;
    let absentCount = 0;

    selects.forEach((sel, i) => {
      const studentId = sel.value;
      const score = scores[i].value;
      // A confirmed student with no readable score counts as ABSENT — saved
      // as Absent (A) instead of being dropped (blank was previously skipped
      // silently). The server stores the absence and excludes it from average.
      if (studentId) {
        if (score === '') { absentCount++; records.push({ student: studentId, score: null }); }
        else { records.push({ student: studentId, score: Number(score) }); }
      } else {
        // No student resolved for this row — it cannot be saved; count it so
        // the teacher sees exactly what "save all" is leaving out.
        missingStudent++;
      }
    });

    if (records.length === 0) {
      alert('No rows are ready to save.\n\n' + (missingStudent > 0
        ? `${missingStudent} row(s) have a score but no student selected`
        : 'Select a student for at least one row.'));
      return;
    }

    // "Save all" saves EVERY row with a student — high, medium and low
    // confidence alike. Rows still missing a student selection can't be
    // persisted, so surface them explicitly instead of dropping silently.
    if (missingStudent > 0 && !confirm(`${missingStudent} row(s) have no student selected and will NOT be saved.\n\nSave the other ${records.length} row(s)?`)) {
      return;
    }

    if (absentCount > 0 && !confirm(`${absentCount} row(s) have no score — they will be saved as Absent (A) and excluded from the class average. Continue?`)) {
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    const res = await fetch('/marks/ocr/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN },
      body: JSON.stringify({ testId, records }),
    });
    const data = await res.json();

    if (data.status === 'success') {
      window.location.href = '/tests/mark?ok=1';
    } else {
      alert(data.message || 'Save failed');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save all rows';
    }
  });
})();
