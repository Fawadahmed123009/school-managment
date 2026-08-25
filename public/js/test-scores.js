(function () {
  const rows = document.querySelectorAll('#roster-body tr');
  const enteredCount = document.getElementById('entered-count');
  const saveBtn = document.getElementById('save-scores-btn');

  function updateCount() {
    let count = 0;
    document.querySelectorAll('.score-input').forEach(function (el) {
      if (el.value !== '') count++;
    });
    if (enteredCount) enteredCount.textContent = count;
  }

  document.querySelectorAll('.score-input').forEach(function (el) {
    el.addEventListener('input', updateCount);
  });
  updateCount();

  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      const records = [];
      rows.forEach(function (row) {
        const studentId = row.dataset.student;
        const input = row.querySelector('.score-input');
        if (input.value !== '') {
          records.push({ student: studentId, score: Number(input.value) });
        }
      });

      if (records.length === 0) {
        alert('Enter at least one score before saving.');
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      document.getElementById('records-input').value = JSON.stringify(records);
      document.getElementById('scores-form').submit();
    });
  }
})();
