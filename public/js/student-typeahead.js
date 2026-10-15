// Shared searchable student picker (typeahead).
//
// Extracted from the Fee add-record selector (public/js/fees-list.js) so the
// app has ONE search-as-you-type implementation. Every consumer keeps its own
// markup ids and its own item source; this only owns the search box behaviour:
//
//   • type            → the dropdown lists matches (name OR roll, substring,
//                       case-insensitive), capped at `limit` rows
//   • click a row     → commits that pupil (mouse + touch + keyboard)
//   • ArrowUp/Down    → move the highlight; Enter commits it (and never lets
//                       the keystroke reach the surrounding <form>, which would
//                       submit the report page mid-search)
//   • Escape / blur   → close / restore the box to the committed pupil
//   • typing without  → the previous pick is invalidated immediately, so a half-
//     picking           typed name can never be submitted as a selection
//
// Rows are built with createElement + textContent (never an innerHTML string),
// so a stored pupil name containing markup can only ever render as text.
//
// Config:
//   input, results  — the text box and its dropdown container
//   items()         — LIVE source of [{id, title, subtitle?, keywords?, label?}];
//                     called on every render, so narrowing performed upstream
//                     (class, grade, section, role scoping) is automatically
//                     respected — the picker can only ever offer what the
//                     caller's current pool contains
//   onSelect(item)  — persist the pick
//   onInvalidate()  — called as soon as the query changes without a pick
//   getSelected()   — → {id, label} | null, the committed pick (for sync/blur)
//   openOnEmpty     — list the whole pool when the box is empty (the fee picker
//                     did exactly that once a class/roll filter was active)
//   emptyText, limit
//
// Returns { sync, refresh, close, invalidate, open } — `sync` realigns the box
// with the committed pick (call it after the pool is rebuilt), `refresh`
// re-renders an open list, `invalidate` drops the pick when the scope above
// changed, `open` renders the list regardless.
(function () {
  window.initStudentTypeahead = function (config) {
    var input = config.input;
    var results = config.results;
    if (!input || !results) return null;

    var items = config.items || function () { return []; };
    var onSelect = config.onSelect || function () {};
    var onInvalidate = config.onInvalidate || function () {};
    var getSelected = config.getSelected || function () { return null; };
    var limit = config.limit || 30;
    var emptyText = config.emptyText || 'No matching students';
    var openOnEmpty = !!config.openOnEmpty;

    var shown = [];      // rows currently rendered (for keyboard navigation)
    var active = -1;     // highlighted index, -1 = none

    function labelOf(item) { return item.label || item.title; }

    function haystack(item) {
      return String(item.keywords == null ? item.title : item.keywords).toLowerCase();
    }

    // Empty the dropdown without ever parsing a markup string (rows are always
    // built with createElement + textContent, so nothing here is innerHTML).
    function clearRows() {
      while (results.firstChild) results.removeChild(results.firstChild);
    }

    // Close (and forget the highlight) without touching the selection.
    function close() {
      clearRows();
      results.style.display = 'none';
      shown = [];
      active = -1;
    }

    function currentMatches() {
      var q = String(input.value || '').trim().toLowerCase();
      var pool = items() || [];
      if (!q) return openOnEmpty ? pool : [];
      return pool.filter(function (it) { return haystack(it).indexOf(q) !== -1; });
    }

    function buildRow(item) {
      var row = document.createElement('div');
      row.className = 'student-typeahead-item';
      var name = document.createElement('strong');
      name.textContent = item.title;
      row.appendChild(name);
      if (item.subtitle) {
        var sub = document.createElement('span');
        sub.textContent = item.subtitle;
        row.appendChild(sub);
      }
      // mousedown + preventDefault: the box must not blur (and so restore an
      // empty query) before the pick is registered. 'click' stays for touch.
      row.addEventListener('mousedown', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        choose(item);
      });
      row.addEventListener('click', function () { choose(item); });
      return row;
    }

    function render() {
      var matches = currentMatches();
      shown = matches.slice(0, limit);
      active = -1;
      clearRows();
      if (matches.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'student-typeahead-empty';
        empty.textContent = openOnEmpty ? emptyText : 'No match — keep typing';
        results.appendChild(empty);
      } else {
        shown.forEach(function (item) { results.appendChild(buildRow(item)); });
      }
      results.style.display = 'block';
    }

    // Repaint only when the list is already open (an upstream cascade change
    // must not pop a dropdown the user is not using).
    function refresh() {
      if (results.style.display === 'block') render();
    }

    function setHighlight(next) {
      if (!shown.length) return;
      var rows = results.querySelectorAll('.student-typeahead-item');
      if (active >= 0 && rows[active]) rows[active].className = 'student-typeahead-item';
      active = (next + shown.length) % shown.length;
      if (rows[active]) rows[active].className = 'student-typeahead-item is-active';
    }

    function choose(item) {
      if (!item) return;
      onSelect(item);
      input.value = labelOf(item);
      close();
    }

    function sync() {
      var sel = getSelected();
      input.value = sel && sel.label ? sel.label : '';
      close();
    }

    // Drop the committed pick and blank the box — used when something upstream
    // of the picker changed (a class filter, a Grade/Section cascade level),
    // so a pupil chosen under the old scope can never survive it.
    function invalidate() {
      onInvalidate();
      input.value = '';
      close();
    }

    input.addEventListener('input', function () {
      // Any edit invalidates the previous pick until a row is chosen again.
      onInvalidate();
      if (!String(input.value || '').trim() && !openOnEmpty) { close(); return; }
      render();
    });
    input.addEventListener('focus', function () {
      if (String(input.value || '').trim() || openOnEmpty) render();
    });
    input.addEventListener('blur', function () { sync(); });
    input.addEventListener('keydown', function (e) {
      var key = e && e.key;
      if (key === 'Escape') { close(); return; }
      if (key === 'ArrowDown') { if (e.preventDefault) e.preventDefault(); if (!shown.length) render(); setHighlight(active + 1); return; }
      if (key === 'ArrowUp') { if (e.preventDefault) e.preventDefault(); if (!shown.length) render(); setHighlight(active - 1); return; }
      if (key === 'Enter') {
        // Never let Enter submit the enclosing form from inside the search box.
        if (e.preventDefault) e.preventDefault();
        choose(shown[active >= 0 ? active : 0]);
      }
    });

    // Click anywhere else dismisses the dropdown (same rule as the fee picker).
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('click', function (e) {
        var target = e && e.target;
        if (target === input) return;
        if (results.contains && results.contains(target)) return;
        if (results.style.display === 'block') close();
      });
    }

    return { sync: sync, refresh: refresh, close: close, invalidate: invalidate, open: render };
  };
})();
