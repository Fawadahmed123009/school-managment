// Teacher salary config page (Phase 2, admin only):
//  1. show only the value field that matches the selected deduction type
//     (flat Rs vs percent);
//  2. relabel the pay entry for a LUMP SUM — it is a fixed amount, not a rate —
//     and reveal the one-line explanation of how that amount is paid.
// Both blocks are independent so a missing control can never disable the other.
(function () {
  var typeSel = document.getElementById('deductionType');
  var flatField = document.getElementById('flatField');
  var percentField = document.getElementById('percentField');

  function refreshDeduction() {
    if (!typeSel || !flatField || !percentField) return;
    var isPercent = typeSel.value === 'percent';
    flatField.style.display = isPercent ? 'none' : '';
    percentField.style.display = isPercent ? '' : 'none';
  }

  if (typeSel) typeSel.addEventListener('change', refreshDeduction);
  refreshDeduction();

  var paySel = document.getElementById('ratePayType');
  var amountLabel = document.getElementById('rateAmountLabel');
  var lumpHint = document.getElementById('lumpSumHint');

  function refreshPayType() {
    var isLump = !!paySel && paySel.value === 'lump-sum';
    if (amountLabel) amountLabel.textContent = isLump ? 'Amount (Rs)' : 'Rate (Rs)';
    if (lumpHint) lumpHint.style.display = isLump ? '' : 'none';
  }

  if (paySel) paySel.addEventListener('change', refreshPayType);
  refreshPayType();
})();