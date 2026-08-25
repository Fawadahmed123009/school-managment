(function () {
  const rows = document.querySelectorAll('#roster-body tr');
  const countEl = document.getElementById('marked-count');
  const saveBtn = document.getElementById('save-attendance-btn');

  function updateCount() {
    const marked = document.querySelectorAll('.attend-btn.active').length;
    if (countEl) countEl.textContent = marked;
  }

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
})();
