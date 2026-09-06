(function () {
  const students = (function () {
    const el = document.getElementById('marks-ocr-students');
    if (el) { try { return JSON.parse(el.textContent); } catch (e) {} }
    return window.__STUDENTS__ || [];
  })();
  const testSelect = document.getElementById('test-select');
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

  pickBtn.addEventListener('click', () => {
    if (!testSelect.value) {
      alert('Select a test first.');
      return;
    }
    testId = testSelect.value;
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    sourcePreview.src = URL.createObjectURL(file);

    const formData = new FormData();
    formData.append('image', file);

    uploadStep.style.display = 'none';
    reviewStep.style.display = 'block';
    rowsBody.innerHTML = '<tr><td colspan="4">Extracting…</td></tr>';

    const res = await fetch('/marks/ocr/extract', { method: 'POST', headers: { 'X-CSRF-Token': window.CSRF_TOKEN }, body: formData });
    const data = await res.json();

    if (data.status !== 'success') {
      rowsBody.innerHTML = `<tr><td colspan="4">Error: ${data.message}</td></tr>`;
      return;
    }

    currentRows = data.data;
    renderRows();
  });

  function renderRows() {
    if (!students.length) {
      rowsBody.innerHTML = '<tr><td colspan="4" style="color:var(--error)">No students loaded. Make sure students exist in the system, then reload this page.</td></tr>';
      rowCount.textContent = '0 rows';
      saveBtn.disabled = true;
      return;
    }
    saveBtn.disabled = false;
    rowCount.textContent = `${currentRows.length} rows`;
    rowsBody.innerHTML = currentRows.map((row, i) => {
      const options = students.map(s => {
        const cls = s.classLevel ? s.classLevel.name : '';
        const roll = s.rollNumber != null ? `Roll #${s.rollNumber}` : '';
        const parts = [cls, roll].filter(Boolean).join(' · ');
        const label = parts ? `${s.name} — ${parts}` : s.name;
        return `<option value="${s._id}" ${row.studentId === s._id ? 'selected' : ''}>${label}</option>`;
      }).join('');
      return `
        <tr data-row="${i}">
          <td><span class="dot ${row.confidence}"></span> ${row.confidence}</td>
          <td>
            <select class="student-select" data-row="${i}">
              <option value="">${row.name || '(unreadable)'} — select student</option>
              ${options}
            </select>
          </td>
          <td class="num"><input type="number" class="score-input" data-row="${i}" value="${row.score ?? ''}" /></td>
          <td><button type="button" class="btn btn-ghost skip-btn" data-row="${i}">Skip</button></td>
        </tr>
      `;
    }).join('');
    updateTotal();
    attachRowEvents();
  }

  function attachRowEvents() {
    document.querySelectorAll('.score-input').forEach(el => el.addEventListener('input', updateTotal));
    document.querySelectorAll('.skip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.row);
        currentRows.splice(i, 1);
        renderRows();
      });
    });
  }

  function updateTotal() {
    let count = 0;
    document.querySelectorAll('.score-input').forEach(el => {
      if (el.value !== '') count++;
    });
    rowTotal.textContent = count;
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
    let missingScore = 0;

    selects.forEach((sel, i) => {
      const studentId = sel.value;
      const score = scores[i].value;
      if (studentId && score !== '') {
        records.push({ student: studentId, score: Number(score) });
      } else {
        if (!studentId) missingStudent++;
        if (score === '') missingScore++;
      }
    });

    if (records.length === 0) {
      const hints = [];
      if (missingStudent > 0) hints.push(`${missingStudent} row(s) have no student selected`);
      if (missingScore > 0) hints.push(`${missingScore} row(s) have no score entered`);
      alert('No rows are ready to save.\n\n' + (hints.join('\n') || 'Select a student and enter a score for at least one row.'));
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
      saveBtn.textContent = 'Save all confirmed rows';
    }
  });
})();
