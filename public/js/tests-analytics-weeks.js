// Combined-subject analytics "Weeks to include" picker — All/Clear shortcuts.
// Pure checkbox state toggling; the form itself (GET /tests/analytics) and the
// stale-guard (hidden axWeeksSubject) are handled server-side, so nothing here
// touches submission. No-ops on every other mode/page where the picker is absent.
(function () {
  var picker = document.getElementById('ax-weeks-picker');
  if (!picker) return;

  function setAll(checked) {
    var boxes = picker.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = checked;
  }

  var allBtn = document.getElementById('ax-weeks-all');
  var noneBtn = document.getElementById('ax-weeks-none');
  if (allBtn) allBtn.addEventListener('click', function () { setAll(true); });
  if (noneBtn) noneBtn.addEventListener('click', function () { setAll(false); });
})();
