(function () {
  const students = window.__STUDENTS__ || [];
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

    const res = await fetch('/marks/ocr/extract', { method: 'POST', body: formData });
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
      const options = students.map(s =>
        `<option value="${s._id}" ${row.studentId === s._id ? 'selected' : ''}>${s.name}</option>`
      ).join('');
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

    selects.forEach((sel, i) => {
      const studentId = sel.value;
      const score = scores[i].value;
      if (studentId && score !== '') records.push({ student: studentId, score: Number(score) });
    });

    if (records.length === 0) {
      alert('Select a student and score for at least one row.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    const res = await fetch('/marks/ocr/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
