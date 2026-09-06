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
    let missingStudent = 0;
    let missingAmount = 0;

    selects.forEach((sel, i) => {
      const studentId = sel.value;
      const amount = amounts[i].value;
      if (studentId && amount) {
        fees.push({ student: studentId, amount: Number(amount) });
      } else {
        if (!studentId) missingStudent++;
        if (!amount) missingAmount++;
      }
    });

    if (fees.length === 0) {
      const hints = [];
      if (missingStudent > 0) hints.push(`${missingStudent} row(s) have no student selected`);
      if (missingAmount > 0) hints.push(`${missingAmount} row(s) have no amount entered`);
      alert('No rows are ready to save.\n\n' + (hints.join('\n') || 'Select a student and enter an amount for at least one row.'));
      return;
    }

    const res = await fetch('/fees/ocr/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN },
      body: JSON.stringify({ fees }),
    });
    const data = await res.json();

    if (data.status === 'success') {
      const s = data.data.summary || {};
      if (data.data.needsReview && data.data.needsReview.length > 0) {
        showReviewSection(data.data);
      } else {
        const parts = [];
        if (s.created) parts.push(`${s.created} created`);
        if (s.updated) parts.push(`${s.updated} updated to paid`);
        alert('Done! ' + parts.join(', '));
        window.location.href = '/fees?ok=1';
      }
    } else {
      alert(data.message || 'Save failed');
    }
  });

  function showReviewSection(result) {
    const reviewStep = document.getElementById('review-step');
    const panel = reviewStep.querySelector('.panel');

    // Hide the original table and show review UI
    const existingReview = document.getElementById('ocr-review-section');
    if (existingReview) existingReview.remove();

    const reviewDiv = document.createElement('div');
    reviewDiv.id = 'ocr-review-section';
    reviewDiv.style.cssText = 'margin-top:20px; border-top:2px solid var(--border, #ddd); padding-top:16px;';

    const s = result.summary || {};
    let msg = '';
    if (s.created) msg += `${s.created} row(s) created. `;
    if (s.updated) msg += `${s.updated} row(s) updated to paid. `;
    msg += `${s.needsReview} row(s) need your review.`;

    let html = `<h3 style="margin-bottom:8px">Needs review</h3>`;
    html += `<p style="margin-bottom:12px; color:var(--text-secondary, #666)">${msg}</p>`;

    result.needsReview.forEach((item, idx) => {
      html += `<div style="margin-bottom:16px; padding:12px; background:var(--bg-secondary, #f9f9f9); border-radius:6px;">`;
      html += `<p><strong>${item.studentName}</strong> — Rs ${item.amount.toLocaleString()}</p>`;
      html += `<p style="font-size:0.9em; color:var(--text-secondary, #888); margin-bottom:8px">Multiple pending fees found. Pick the one this payment matches:</p>`;
      item.candidates.forEach((c) => {
        const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : 'unknown date';
        const label = c.feeType || 'fee';
        html += `<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">`;
        html += `<button type="button" class="btn btn-primary resolve-btn" data-fee-id="${c._id}" style="font-size:0.85em; padding:4px 12px;">Pick this</button>`;
        html += `<span>${label} — Rs ${c.amount} — created ${date}</span>`;
        if (c.notes) html += `<span style="color:var(--text-secondary, #888); font-size:0.85em">(${c.notes})</span>`;
        html += `</div>`;
      });
      html += `</div>`;
    });

    html += `<div style="margin-top:12px; display:flex; gap:10px;">`;
    html += `<button type="button" class="btn btn-primary" id="finish-review-btn">Go to fees list</button>`;
    html += `</div>`;

    reviewDiv.innerHTML = html;
    panel.appendChild(reviewDiv);

    // Attach resolve handlers
    reviewDiv.querySelectorAll('.resolve-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const feeId = btn.dataset.feeId;
        btn.disabled = true;
        btn.textContent = 'Saving…';
        const res = await fetch(`/fees/ocr/resolve/${feeId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF_TOKEN },
        });
        const data = await res.json();
        if (data.status === 'success') {
          btn.textContent = 'Paid ✓';
          btn.disabled = true;
          btn.style.opacity = '0.6';
        } else {
          alert(data.message || 'Failed to update');
          btn.disabled = false;
          btn.textContent = 'Pick this';
        }
      });
    });

    document.getElementById('finish-review-btn').addEventListener('click', () => {
      window.location.href = '/fees?ok=1';
    });
  }
})();
