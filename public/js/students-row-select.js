// Row selection for the Students register (views/students/list.ejs).
//
// The roster table carries a leading checkbox column so an admin or manager can
// tick pupils up. Only the SELECTION STATE is owned here — there is deliberately
// no bulk action wired to it yet, so the checkboxes cannot change any data. When
// a bulk feature lands it can read the checked boxes with:
//
//   document.querySelectorAll('.roster-table .st-row-check:checked')
//
// and each box's value is the Student _id of its row (the row itself also keeps
// the id on `data-student-id`).
//
// The header box is a page-scoped "select all on THIS page" — pagination is
// server-side, so only the rows currently rendered are ever touched. It mirrors
// the rows below it and goes indeterminate when only some are checked; a row
// ticked by hand updates the header, so the two can never drift apart.
//
// Bound from an external file on purpose: helmet sets script-src 'self' (no
// 'unsafe-inline'), so an inline <script> in the view would be blocked.
(function () {
  var table = document.querySelector('.roster-table');
  if (!table) return;

  var header = document.getElementById('st-select-all');
  var boxes = Array.prototype.slice.call(table.querySelectorAll('.st-row-check'));
  if (!boxes.length) {
    if (header) header.disabled = true; // nothing rendered (empty filter result)
    return;
  }

  // Header → rows: check or uncheck every row on this page in one click.
  if (header) {
    header.addEventListener('change', function () {
      var on = header.checked;
      boxes.forEach(function (box) { box.checked = on; });
      header.indeterminate = false;
    });
  }

  // Rows → header: reflect how many are ticked.
  function syncHeader() {
    if (!header) return;
    var checked = boxes.filter(function (box) { return box.checked; }).length;
    header.checked = checked === boxes.length;
    header.indeterminate = checked > 0 && checked < boxes.length;
  }

  boxes.forEach(function (box) { box.addEventListener('change', syncHeader); });
  syncHeader();
})();
