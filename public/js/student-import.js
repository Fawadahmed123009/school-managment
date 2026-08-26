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

    const res = await fetch('/students/import/parse', { method: 'POST', headers: { 'X-CSRF-Token': window.CSRF_TOKEN }, body: formData });
    const data = await res.json();

    if (data.status !== 'success') {
      rowsBody.innerHTML = `<tr><td colspan="4">Error: ${data.message}</td></tr>`;
      return;
    }

    currentRows = data.data;
    renderRows();
  });

  function renderRows() {
    rowCount.textContent = `${currentRows.length} rows`;
    rowsBody.innerHTML = currentRows.map((row, i) => {
      const options = classes.map(c =>
        `<option value="${c._id}" ${row.matchedClassId === c._id ? 'selected' : ''}>${c.name}</option>`
      ).join('');
      const matchLabel = row.matchedClassId
        ? ''
        : `<div style="color:var(--error); font-size:12px; margin-bottom:4px;">No match for "${row.rawClassText || '(blank)'}" — pick manually</div>`;
      return `
        <tr data-row="${i}">
          <td>${row.name}</td>
          <td class="mono">${row.admissionNumber || '—'}</td>
          <td><input type="number" class="roll-input" data-row="${i}" min="1" value="${row.rollNumber ?? ''}" style="width:80px;" /></td>
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
      alert('Two or more rows have the same roll number in the same class. Fix the highlighted rows before importing.');
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
          rollNumber: Number(rollNumber),
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
      alert('Match at least one row to a class with a roll number before importing.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Importing…';

    const res = await fetch('/students/import/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN },
      body: JSON.stringify({ students }),
    });
    const data = await res.json();

    if (data.status !== 'success') {
      alert(data.message || 'Import failed');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Import confirmed rows';
      return;
    }

    const { created, skipped } = data.data;
    reviewStep.style.display = 'none';
    resultsStep.style.display = 'block';
    document.getElementById('results-summary').textContent =
      `${created.length} student(s) created. ${skipped.length} skipped.`;

    document.getElementById('created-body').innerHTML = created.map(s => `
      <tr><td>${s.name}</td><td>${s.email}</td><td class="mono">${s.tempPassword}</td></tr>
    `).join('');
  });
})();
