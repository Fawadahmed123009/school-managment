/**
 * Marks audit filter toolbar.
 *
 * Every select submits the GET filter form on change, so the ledger re-renders
 * server-side with the choice applied. The five category selects are a real
 * cascade — session → grade → phase → week → subject — so changing a level
 * clears everything BELOW it before submitting: a stale week or subject left
 * over from the previous phase would filter the ledger to an empty page while
 * its own dropdown no longer even offered that value.
 *
 * `teacher` is a typeahead (a search input backed by a <datalist> of every
 * marker's name). Committing it — picking a suggestion, or typing a partial
 * name and leaving the field — fires `change`, which is enough to submit; the
 * form's own submit button and the Enter key cover the rest.
 *
 * Bound from an external file on purpose: helmet sets script-src-attr 'none',
 * so an inline onchange="this.form.submit()" attribute is blocked and never
 * runs — the dropdowns would silently do nothing until "Search" was clicked.
 */
(function () {
  var form = document.getElementById('marks-audit-filter');
  if (!form || !form.elements) return;

  // Cascade order, broadest first.
  var CASCADE = ['session', 'grade', 'phase', 'week', 'subject'];

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

  // Status narrows on its own; the teacher typeahead commits on change.
  onChange('status', function () {
    form.submit();
  });
  var teacher = field('teacher');
  if (teacher) {
    teacher.addEventListener('change', function () {
      // Don't reload for a keystroke that never landed: only submit when the
      // typed value actually differs from the one the page was rendered with.
      if (teacher.value === (teacher.defaultValue || '')) return;
      form.submit();
    });
  }
})();
