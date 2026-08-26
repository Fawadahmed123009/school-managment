(function () {
  const btn = document.getElementById('view-report-btn');
  const select = document.getElementById('studentId');
  if (!btn || !select) return;

  btn.addEventListener('click', function () {
    const v = select.value;
    const sessionId = btn.dataset.sessionId;
    if (v && sessionId) window.location.href = '/sessions/' + sessionId + '/report/' + v;
  });
})();
