// Expense entry form (Phase 3, admin only). Auto-calculates the total as
// quantity × unit rate while the admin types — there is no manual total field.
// The server recomputes totalAmount on save, so this display is UX only and is
// never trusted as the stored amount (same rule as the salary preview).
(function () {
  var qty = document.getElementById('quantity');
  var rate = document.getElementById('unitRate');
  var total = document.getElementById('totalDisplay');
  // The create panel is present on this page; the per-row edit forms below are
  // wired independently so one missing panel can never disable the other.
  var createPanel = qty && rate && total;

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
    if (!createPanel) return;
    var q = parseFloat(qty.value);
    var r = parseFloat(rate.value);
    // Decimals are supported (2.5 units, Rs 45.50). Show 0 until both are valid.
    if (!isFinite(q) || !isFinite(r) || q <= 0 || r < 0) {
      total.value = '0.00';
      return;
    }
    total.value = fmt(round2(q * r));
  }

  if (createPanel) {
    qty.addEventListener('input', recalc);
    rate.addEventListener('input', recalc);
    recalc();
  }

  // ── Per-row EDIT forms in the history table ───────────────────────────────
  // Expenses have no manual-total mode anywhere (create recomputes, and so does
  // update), so the edit row's total box is read-only — a live preview of
  // quantity × unit rate only. The server always recomputes on save.
  document.querySelectorAll('form.expense-edit-form').forEach(function (ef) {
    var eQty = ef.querySelector('.edit-qty');
    var eRate = ef.querySelector('.edit-rate');
    var eTotal = ef.querySelector('.edit-total-display');
    if (!eQty || !eRate || !eTotal) return;

    function sync() {
      var q = parseFloat(eQty.value);
      var r = parseFloat(eRate.value);
      if (isFinite(q) && isFinite(r) && q > 0 && r >= 0) {
        eTotal.value = String(round2(q * r));
      }
    }

    eQty.addEventListener('input', sync);
    eRate.addEventListener('input', sync);
  });
})();
