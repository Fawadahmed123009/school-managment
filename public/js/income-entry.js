// Income entry form (admin only). Two amount modes:
//   • quantity × unit rate → total auto-calculates (display only; the server
//     recomputes totalAmount on save, so this preview is never trusted).
//   • direct total → admin enters the amount (e.g. a lump donation).
// The server derives the mode from WHICH fields are submitted, so inactive-panel
// inputs are DISABLED here (disabled controls are never submitted) — that keeps
// the server's field-presence detection clean. Required is managed alongside so
// a hidden control can never block submission. External file: helmet CSP blocks
// inline scripts (same convention as expense-entry.js).
(function () {
  var form = document.getElementById('incomeEntryForm');
  if (!form) return; // not the income entry page

  var modeInput = document.getElementById('entryMode');
  var qty = document.getElementById('quantity');
  var rate = document.getElementById('unitRate');
  var totalDisplay = document.getElementById('totalDisplay');
  var totalAmount = document.getElementById('totalAmount');
  var buttons = form.querySelectorAll('[data-mode]');
  var panels = form.querySelectorAll('[data-for]');

  function round2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function recalc() {
    if (!qty || !rate || !totalDisplay) return;
    var q = parseFloat(qty.value);
    var r = parseFloat(rate.value);
    // Decimals are supported (2.5 units, Rs 45.50). Show 0 until both are valid.
    if (!isFinite(q) || !isFinite(r) || q <= 0 || r < 0) {
      totalDisplay.value = '0.00';
      return;
    }
    totalDisplay.value = fmt(round2(q * r));
  }

  function apply(mode) {
    var isQty = mode === 'quantity';
    if (modeInput) modeInput.value = isQty ? 'quantity' : 'direct';
    buttons.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
    panels.forEach(function (p) {
      p.style.display = p.getAttribute('data-for') === mode ? '' : 'none';
    });
    if (qty) { qty.disabled = !isQty; qty.required = isQty; }
    if (rate) { rate.disabled = !isQty; rate.required = isQty; }
    if (totalAmount) { totalAmount.disabled = isQty; totalAmount.required = !isQty; }
    if (isQty) recalc();
  }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () { apply(b.getAttribute('data-mode')); });
  });
  if (qty) qty.addEventListener('input', recalc);
  if (rate) rate.addEventListener('input', recalc);

  // Initialise from the hidden field (defaults to quantity mode on a fresh load).
  apply(modeInput && modeInput.value === 'direct' ? 'direct' : 'quantity');
})();