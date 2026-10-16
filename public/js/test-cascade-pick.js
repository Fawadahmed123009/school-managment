/**
 * Manual mark-entry page wrapper. All cascade logic (Session → Grade →
 * Section → Phase → Week → Subject → Test) lives in the shared
 * test-cascade-filters.js; this script only reacts to the final test choice
 * and wires up the "Mark this test" action.
 */
(function() {
  var markAction = document.getElementById('mark-action');
  var markBtn = document.getElementById('mark-btn');
  var testInfo = document.getElementById('test-info');

  if (!markAction || !markBtn) return;

  // ── React to test selection from shared cascade filters ────────────────
  document.addEventListener('cascade:test-changed', function(e) {
    var testId = e.detail.testId;
    if (testId) {
      markBtn.href = '/tests/mark/' + testId;
      // Find the label from the test select dropdown
      var testSelect = document.getElementById('test-select');
      testInfo.textContent = testSelect.options[testSelect.selectedIndex].textContent;
      markAction.style.display = 'flex';
      markAction.style.alignItems = 'center';
    } else {
      markAction.style.display = 'none';
    }
  });
})();
