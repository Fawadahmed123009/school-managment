(function () {
  function updatePhaseOptions() {
    const sessionSelect = document.getElementById('session');
    const phaseSelect = document.getElementById('phase');
    const selected = sessionSelect.options[sessionSelect.selectedIndex];
    const phasesAttr = selected.getAttribute('data-phases');

    phaseSelect.innerHTML = '<option value="">—</option>';
    if (phasesAttr) {
      const phases = JSON.parse(phasesAttr);
      phases.forEach(function (p) {
        const opt = document.createElement('option');
        opt.value = p._id;
        opt.textContent = p.name;
        phaseSelect.appendChild(opt);
      });
    }
  }

  const sessionSelect = document.getElementById('session');
  if (sessionSelect) {
    sessionSelect.addEventListener('change', updatePhaseOptions);
  }
})();
