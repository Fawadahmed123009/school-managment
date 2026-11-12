// Expense entry form (Phase 3, admin only). Auto-calculates the total as
// quantity × unit rate while the admin types — there is no manual total field.
// The server recomputes totalAmount on save, so this display is UX only and is
// never trusted as the stored amount (same rule as the salary preview).
(function () {
  var qty = document.getElementById('quantity');
  var rate = document.getElementById('unitRate');
  var total = document.getElementById('totalDisplay');
  if (!qty || !rate || !total) return; // not the expense entry page

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
    var q = parseFloat(qty.value);
    var r = parseFloat(rate.value);
    // Decimals are supported (2.5 units, Rs 45.50). Show 0 until both are valid.
    if (!isFinite(q) || !isFinite(r) || q <= 0 || r < 0) {
      total.value = '0.00';
      return;
    }
    total.value = fmt(round2(q * r));
  }

  qty.addEventListener('input', recalc);
  rate.addEventListener('input', recalc);
  recalc();
})();
