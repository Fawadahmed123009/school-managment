// Report-type toggle on the PDF report form.
//
// A segmented button group replaces the old <select>. The visible buttons are
// the control; the hidden #reportType field is what actually submits and is the
// single source of truth the other panel scripts' submit guards read. Clicking a
// button sets the hidden value, moves the active styling, and reveals only that
// report's option panel (the others are hidden, never removed). Panels are also
// synced on load from the hidden field's server-rendered default.
(function () {
  const reportType = document.getElementById('reportType');
  if (!reportType) return;

  const toggleBar = document.getElementById('reportType-toggle');
  const buttons = toggleBar ? Array.prototype.slice.call(toggleBar.querySelectorAll('[data-report-type]')) : [];

  function apply(value) {
    if (!value) return;
    reportType.value = value;
    buttons.forEach(function (btn) {
      btn.className = btn.dataset.reportType === value ? 'btn btn-primary' : 'btn btn-ghost';
    });
    document.querySelectorAll('.report-fields').forEach(function (el) {
      el.style.display = el.dataset.for === value ? '' : 'none';
    });
  }

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () { apply(btn.dataset.reportType); });
  });

  // Initialise from the hidden field (falls back to the first button).
  apply(reportType.value || (buttons[0] && buttons[0].dataset.reportType));
})();
