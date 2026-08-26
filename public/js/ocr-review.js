(function () {
  const students = (function () {
    const el = document.getElementById('ocr-students');
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
  const totalAmount = document.getElementById('total-amount');
  const saveBtn = document.getElementById('save-btn');
  const rescanBtn = document.getElementById('rescan-btn');

  let currentRows = [];

  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;

    sourcePreview.src = URL.createObjectURL(file);

    const formData = new FormData();
    formData.append('image', file);

    uploadStep.style.display = 'none';
    reviewStep.style.display = 'block';
    rowsBody.innerHTML = '<tr><td colspan="4">Extracting…</td></tr>';

    const res = await fetch('/fees/ocr/extract', { method: 'POST', headers: { 'X-CSRF-Token': window.CSRF_TOKEN }, body: formData });
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
          <td class="num"><input type="number" class="amount-input" data-row="${i}" value="${row.amount ?? ''}" /></td>
          <td><button type="button" class="btn btn-ghost skip-btn" data-row="${i}">Skip</button></td>
        </tr>
      `;
    }).join('');
    updateTotal();
    attachRowEvents();
  }

  function attachRowEvents() {
    document.querySelectorAll('.amount-input').forEach(el => el.addEventListener('input', updateTotal));
    document.querySelectorAll('.skip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.row);
        currentRows.splice(i, 1);
        renderRows();
      });
    });
  }

  function updateTotal() {
    let total = 0;
    document.querySelectorAll('.amount-input').forEach(el => {
      total += Number(el.value) || 0;
    });
    totalAmount.textContent = total.toLocaleString();
  }

  rescanBtn.addEventListener('click', () => {
    reviewStep.style.display = 'none';
    uploadStep.style.display = 'block';
    fileInput.value = '';
    currentRows = [];
  });

  saveBtn.addEventListener('click', async () => {
    const selects = document.querySelectorAll('.student-select');
    const amounts = document.querySelectorAll('.amount-input');
    const fees = [];

    selects.forEach((sel, i) => {
      const studentId = sel.value;
      const amount = amounts[i].value;
      if (studentId && amount) fees.push({ student: studentId, amount: Number(amount) });
    });

    if (fees.length === 0) {
      alert('Select a student and amount for at least one row.');
      return;
    }

    const res = await fetch('/fees/ocr/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN },
      body: JSON.stringify({ fees }),
    });
    const data = await res.json();

    if (data.status === 'success') {
      window.location.href = '/fees?ok=1';
    } else {
      alert(data.message || 'Save failed');
    }
  });
})();
