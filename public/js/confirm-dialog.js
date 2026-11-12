// Themed confirmation dialog — a Promise-based, non-blocking replacement for
// window.confirm().
//
// Why this exists: inside the installed PWA / WebView, window.confirm() can be
// a silent no-op that returns false, so a gated action (Save, Delete) quietly
// never happens — the exact root cause of the original marks-entry bug. This
// dialog is plain DOM in the page: it always renders, always resolves, and
// works identically in a browser tab and the installed app.
//
// Usage:
//   var ok = await ConfirmDialog.ask({
//     title: 'Delete this fee record?',
//     message: 'This cannot be undone.',
//     confirmLabel: 'Delete',
//     danger: true
//   });
//
// Semantics match window.confirm: resolve(true) = proceed, resolve(false) =
// cancel. Esc, the scrim, and the Cancel button all cancel. For danger
// actions focus starts on Cancel (safe default); Enter activates whichever
// button is focused, never an implicit "confirm".
(function () {
  'use strict';

  var queue = Promise.resolve();

  function build(opts) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'confirm-dialog' + (opts.danger ? ' confirm-danger' : '');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'confirm-dialog-title');
    dialog.setAttribute('aria-describedby', 'confirm-dialog-message');

    var title = document.createElement('h2');
    title.className = 'confirm-title';
    title.id = 'confirm-dialog-title';
    title.textContent = opts.title || 'Are you sure?';
    dialog.appendChild(title);

    var message = document.createElement('div');
    message.className = 'confirm-message';
    message.id = 'confirm-dialog-message';
    // Newlines become paragraphs; textContent only — messages embed user
    // input (student names, counts) and must never be interpreted as HTML.
    String(opts.message || '').split(/\n+/).forEach(function (para) {
      if (!para) return;
      var p = document.createElement('p');
      p.textContent = para;
      message.appendChild(p);
    });
    if (!message.children.length) message.style.display = 'none';
    dialog.appendChild(message);

    var actions = document.createElement('div');
    actions.className = 'confirm-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost confirm-cancel';
    cancel.textContent = opts.cancelLabel || 'Cancel';
    var confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn confirm-ok ' + (opts.danger ? 'btn-danger' : 'btn-primary');
    confirm.textContent = opts.confirmLabel || 'Confirm';
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    return { overlay: overlay, dialog: dialog, cancel: cancel, confirm: confirm };
  }

  function ask(opts) {
    opts = opts || {};
    // Serialize: a second ask while one is open queues behind it rather than
    // stacking two scrims (double-click on a gated button, etc.).
    var run = queue.then(function () { return open(opts); });
    queue = run.catch(function () {});
    return run;
  }

  function open(opts) {
    return new Promise(function (resolve) {
      var ui = build(opts);
      var previousFocus = document.activeElement;
      var settled = false;

      function done(result) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        ui.overlay.classList.add('confirm-out');
        setTimeout(function () {
          if (ui.overlay.parentNode) ui.overlay.parentNode.removeChild(ui.overlay);
          if (previousFocus && previousFocus.focus) {
            try { previousFocus.focus(); } catch (e) { /* element gone */ }
          }
          resolve(result);
        }, 150);
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done(false);
        } else if (e.key === 'Tab') {
          // Keep Tab cycling inside the dialog — the page behind is inert
          // while the scrim is up.
          var first = ui.cancel;
          var last = ui.confirm;
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }

      ui.cancel.addEventListener('click', function () { done(false); });
      ui.confirm.addEventListener('click', function () { done(true); });
      // Scrim click cancels — but only a press that STARTS on the scrim, so
      // a text-selection drag ending outside the panel never dismisses it.
      var downOnOverlay = false;
      ui.overlay.addEventListener('mousedown', function (e) { downOnOverlay = e.target === ui.overlay; });
      ui.overlay.addEventListener('mouseup', function (e) {
        if (downOnOverlay && e.target === ui.overlay) done(false);
        downOnOverlay = false;
      });
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(ui.overlay);
      // Safe default for destructive actions: Cancel is focused, so a stray
      // Enter/Space cannot confirm a delete.
      (opts.danger ? ui.cancel : ui.confirm).focus();
    });
  }

  window.ConfirmDialog = { ask: ask };
})();