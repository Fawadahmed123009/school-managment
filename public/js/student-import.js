(function () {
  const classes = (function () {
    const el = document.getElementById('import-classes');
    if (el) { try { return JSON.parse(el.textContent); } catch (e) {} }
    return window.__CLASSES__ || [];
  })();
  const pickBtn = document.getElementById('pick-file-btn');
  const fileInput = document.getElementById('file-input');
  const uploadStep = document.getElementById('upload-step');
  const reviewStep = document.getElementById('review-step');
  const resultsStep = document.getElementById('results-step');
  const rowsBody = document.getElementById('rows-body');
  const rowCount = document.getElementById('row-count');
  const readyCount = document.getElementById('ready-count');
  const saveBtn = document.getElementById('save-btn');
  const rescanBtn = document.getElementById('rescan-btn');

  let currentRows = [];

  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    uploadStep.style.display = 'none';
    reviewStep.style.display = 'block';
    rowsBody.innerHTML = '<tr><td colspan="4">Parsing…</td></tr>';

    // fetchJson never throws and never assumes JSON: a dropped connection or
    // an HTML error page (expired session, proxy) becomes a visible message
    // instead of an unhandled rejection that left "Parsing…" stuck forever.
    const result = await FormFeedback.fetchJson('/students/import/parse', { method: 'POST', body: formData, action: 'Parse' });
    if (!result.ok) {
      rowsBody.innerHTML = `<tr><td colspan="4">Error: ${window.escapeHtml(result.message)}</td></tr>`;
      Toast.error(result.message, { title: 'Could not parse the file' });
      return;
    }

    currentRows = result.payload.data;
    renderRows();
  });

  function renderRows() {
    rowCount.textContent = `${currentRows.length} rows`;
    rowsBody.innerHTML = currentRows.map((row, i) => {
      const esc = window.escapeHtml;
      const options = classes.map(c =>
        `<option value="${esc(c._id)}" ${row.matchedClassId === c._id ? 'selected' : ''}>${esc(c.name)}</option>`
      ).join('');
      const matchLabel = row.matchedClassId
        ? ''
        : `<div style="color:var(--error); font-size:12px; margin-bottom:4px;">No match for "${esc(row.rawClassText || '(blank)')}" — pick manually</div>`;
      return `
        <tr data-row="${i}">
          <td>${esc(row.name)}</td>
          <td class="mono">${esc(row.admissionNumber || '—')}</td>
          <td><input type="text" class="roll-input" data-row="${i}" value="${esc(row.rollNumber ?? '')}" style="width:100px;" /></td>
          <td>
            ${matchLabel}
            <select class="class-select" data-row="${i}">
              <option value="">-- select class --</option>
              ${options}
            </select>
          </td>
        </tr>
      `;
    }).join('');
    updateReadyCount();
    document.querySelectorAll('.class-select').forEach(el => el.addEventListener('change', updateReadyCount));
    document.querySelectorAll('.roll-input').forEach(el => el.addEventListener('input', updateReadyCount));
  }

  // Flags rows sharing the same {class, roll number} pair within this batch,
  // so the admin sees a duplicate BEFORE submitting, not after a server rejection.
  function findBatchDuplicates() {
    const seen = new Map();
    const dupeRows = new Set();

    document.querySelectorAll('#rows-body tr').forEach((tr) => {
      const i = tr.dataset.row;
      const classSel = tr.querySelector('.class-select');
      const rollInput = tr.querySelector('.roll-input');
      if (!classSel.value || rollInput.value === '') return;

      const key = `${classSel.value}:${rollInput.value}`;
      if (seen.has(key)) {
        dupeRows.add(i);
        dupeRows.add(seen.get(key));
      } else {
        seen.set(key, i);
      }
    });

    return dupeRows;
  }

  function updateReadyCount() {
    const dupeRows = findBatchDuplicates();
    let count = 0;

    document.querySelectorAll('#rows-body tr').forEach((tr) => {
      const i = tr.dataset.row;
      const classSel = tr.querySelector('.class-select');
      const rollInput = tr.querySelector('.roll-input');
      const complete = classSel.value && rollInput.value !== '';

      rollInput.style.borderColor = dupeRows.has(i) ? 'var(--error)' : '';
      if (complete && !dupeRows.has(i)) count++;
    });

    readyCount.textContent = count;
  }

  rescanBtn.addEventListener('click', () => {
    reviewStep.style.display = 'none';
    uploadStep.style.display = 'block';
    fileInput.value = '';
    currentRows = [];
  });

  saveBtn.addEventListener('click', async () => {
    const dupeRows = findBatchDuplicates();
    if (dupeRows.size > 0) {
      // Toast, not alert() — a blocking dialog can be a silent no-op in the
      // installed PWA, which made this guard look like a dead Save button.
      Toast.warning('Two or more rows have the same roll number in the same class. Fix the highlighted rows before importing.', { title: 'Duplicate rows' });
      return;
    }

    const classSelects = document.querySelectorAll('.class-select');
    const rollInputs = document.querySelectorAll('.roll-input');
    const students = [];

    classSelects.forEach((sel, i) => {
      const classLevel = sel.value;
      const rollNumber = rollInputs[i].value;
      if (classLevel && rollNumber !== '') {
        const student = {
          name: currentRows[i].name,
          admissionNumber: currentRows[i].admissionNumber,
          classLevel,
          rollNumber: rollNumber,
        };
        if (currentRows[i].fatherName) student.fatherName = currentRows[i].fatherName;
        if (currentRows[i].address) student.address = currentRows[i].address;
        if (currentRows[i].whatsappNumber) student.whatsappNumber = currentRows[i].whatsappNumber;
        if (currentRows[i].feeAgreed !== undefined) student.feeAgreed = currentRows[i].feeAgreed;
        if (currentRows[i].gender) student.gender = currentRows[i].gender;
        students.push(student);
      }
    });

    if (students.length === 0) {
      Toast.warning('Match at least one row to a class with a roll number before importing.', { title: 'Nothing to import' });
      return;
    }

    // busy() restores the label/disabled state on every exit path AND on
    // bfcache pageshow — Back never lands on a dead "Importing…" button.
    const restore = FormFeedback.busy(saveBtn, 'Importing…');
    const result = await FormFeedback.fetchJson('/students/import/confirm', {
      method: 'POST',
      body: JSON.stringify({ students }),
      action: 'Import',
    });
    restore();

    if (!result.ok) {
      Toast.error(result.message, { title: 'Import failed' });
      return;
    }

    const { created, skipped } = result.payload.data;
    reviewStep.style.display = 'none';
    resultsStep.style.display = 'block';
    document.getElementById('results-summary').textContent =
      `${created.length} student(s) created. ${skipped.length} skipped.`;

    document.getElementById('created-body').innerHTML = created.map(s => `
      <tr><td>${window.escapeHtml(s.name)}</td><td>${window.escapeHtml(s.email)}</td><td class="mono">${window.escapeHtml(s.tempPassword)}</td></tr>
    `).join('');
    Toast.success(`${created.length} student(s) created, ${skipped.length} skipped.`, { title: 'Import complete' });
  });
})();
