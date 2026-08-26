(function () {
  const goBtn = document.getElementById('attendance-go-btn');
  const select = document.getElementById('classLevel');
  if (!goBtn || !select) return;

  goBtn.addEventListener('click', function () {
    const v = select.value;
    if (v) window.location.href = '/attendance/mark/' + v;
  });
})();
