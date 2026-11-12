// Teacher salary config page (Phase 2, admin only): show only the value
// field that matches the selected deduction type (flat Rs vs percent).
(function () {
  var typeSel = document.getElementById('deductionType');
  if (!typeSel) return; // not the config page

  var flatField = document.getElementById('flatField');
  var percentField = document.getElementById('percentField');

  function refresh() {
    var isPercent = typeSel.value === 'percent';
    flatField.style.display = isPercent ? 'none' : '';
    percentField.style.display = isPercent ? '' : 'none';
  }

  typeSel.addEventListener('change', refresh);
  refresh();
})();