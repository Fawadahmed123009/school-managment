(function () {
  const rows = document.querySelectorAll('#roster-body tr');
  const countEl = document.getElementById('marked-count');
  const saveBtn = document.getElementById('save-attendance-btn');
  const markAllBtn = document.getElementById('mark-all-present-btn');
  const filterName = document.getElementById('filter-name');
  const filterRoll = document.getElementById('filter-roll');

  function updateCount() {
    const marked = document.querySelectorAll('.attend-btn.active').length;
    if (countEl) countEl.textContent = marked;
  }

  // Wire up individual toggle buttons
  rows.forEach((row) => {
    const buttons = row.querySelectorAll('.attend-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        updateCount();
      });
    });
  });

  updateCount();

  // ── Mark all as Present ──────────────────────
  if (markAllBtn) {
    markAllBtn.addEventListener('click', () => {
      rows.forEach((row) => {
        const presentBtn = row.querySelector('.attend-btn[data-status="present"]');
        if (presentBtn) {
          row.querySelectorAll('.attend-btn').forEach((b) => b.classList.remove('active'));
          presentBtn.classList.add('active');
        }
      });
      updateCount();
    });
  }

  // ── Roster filters (visibility only) ─────────
  function applyFilters() {
    const nameQ = (filterName ? filterName.value : '').toLowerCase().trim();
    const rollQ = (filterRoll ? filterRoll.value : '').toLowerCase().trim();

    rows.forEach((row) => {
      const name = row.dataset.name || '';
      const roll = row.dataset.roll || '';
      const matchName = !nameQ || name.includes(nameQ);
      const matchRoll = !rollQ || roll.includes(rollQ);
      row.style.display = matchName && matchRoll ? '' : 'none';
    });
  }

  if (filterName) filterName.addEventListener('input', applyFilters);
  if (filterRoll) filterRoll.addEventListener('input', applyFilters);

  // ── Save — iterates ALL rows regardless of filter visibility ──
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const records = [];
      rows.forEach((row) => {
        const studentId = row.dataset.student;
        const activeBtn = row.querySelector('.attend-btn.active');
        if (activeBtn) {
          records.push({ student: studentId, status: activeBtn.dataset.status });
        }
      });

      if (records.length === 0) {
        alert('Mark at least one student before saving.');
        return;
      }

      document.getElementById('records-input').value = JSON.stringify(records);
      document.getElementById('attendance-form').submit();
    });
  }

  // Date navigation: reload the roster for the chosen date.
  const datePicker = document.getElementById('date-picker');
  if (datePicker) {
    datePicker.addEventListener('change', function () {
      const base = datePicker.dataset.markBase;
      if (base) window.location.href = base + '?date=' + this.value;
    });
  }
})();
