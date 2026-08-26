(function () {
  const addBtn = document.getElementById('add-phase-btn');
  if (!addBtn) return;

  addBtn.addEventListener('click', function () {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'phaseNames';
    input.placeholder = 'Phase ' + (document.querySelectorAll('#phase-inputs input').length + 1);
    input.style.marginBottom = '6px';
    document.getElementById('phase-inputs').appendChild(input);
  });
})();
