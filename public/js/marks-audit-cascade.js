/**
 * Marks audit filter toolbar.
 *
 * Every select submits the GET filter form on change, so the ledger re-renders
 * server-side with the choice applied. The three category selects are a real
 * cascade — session → grade → class — so changing a level clears everything
 * BELOW it before submitting: a stale grade / class left over from the previous
 * session would filter the ledger to an empty page while its own dropdown no
 * longer even offered that value.
 *
 * Bound from an external file on purpose: helmet sets script-src-attr 'none',
 * so an inline onchange="this.form.submit()" attribute is blocked and never
 * runs — the dropdowns would silently do nothing until "Search" was clicked.
 */
(function () {
  var form = document.getElementById('marks-audit-filter');
  if (!form || !form.elements) return;

  // Cascade order, broadest first.
  var CASCADE = ['session', 'grade', 'classLevel'];

  function field(name) {
    return form.elements[name] || null;
  }

  function onChange(name, handler) {
    var el = field(name);
    if (el) el.addEventListener('change', handler);
  }

  CASCADE.forEach(function (name, level) {
    onChange(name, function () {
      // Downstream levels are reset first — their option lists are rebuilt
      // from the new selection when the page comes back.
      CASCADE.slice(level + 1).forEach(function (below) {
        var el = field(below);
        if (el) el.value = '';
      });
      form.submit();
    });
  });

  ['status', 'teacher'].forEach(function (name) {
    onChange(name, function () { form.submit(); });
  });
})();
