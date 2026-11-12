// Two related jobs, both loaded globally via views/partials/foot.ejs:
//
//  1. A themed confirmation gate for any form carrying data-confirm="message".
//     Uses ConfirmDialog (plain DOM, Promise-based) instead of window.confirm:
//     inside the installed PWA / WebView, confirm() can be a silent no-op that
//     returns false, so a gated Delete quietly never happens — the exact root
//     cause of the original marks-entry bug. The dialog always renders and
//     always resolves, identically in a browser tab and the installed app.
//     This also replaces inline onsubmit="return confirm(...)" handlers, which
//     are blocked by the CSP script-src-attr 'none' directive.
//
//  2. Double-submit protection for EVERY POST form. These forms are plain HTML
//     posts that navigate away on submit (the server redirects back), so once a
//     submission is in flight a second click can only fire a duplicate request —
//     historically the cause of two byte-identical records (e.g. a test created
//     twice on the same date, or a week cloned twice). We lock the form after a
//     genuine submit and disable its submit button; a later "pageshow" from the
//     back/forward cache unlocks it so navigating back to re-submit still works.
document.addEventListener('DOMContentLoaded', function() {
  function lockForm(form) {
    form.__locked = true;
    // Hard-block a second click: disable the submit control while the POST is
    // in flight. The label is left untouched (a disabled button still reads).
    form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(function(btn) {
      btn.disabled = true;
    });
  }

  document.querySelectorAll('form[data-confirm]').forEach(function(form) {
    form.addEventListener('submit', function(e) {
      // One-shot bypass: the re-fired submit after a confirmed dialog must
      // pass straight through to the lock + native submit below.
      if (form.__confirmBypass) { form.__confirmBypass = false; return; }
      // Already submitting (lock below): an Enter-key submit must not pop
      // the dialog again while the POST is in flight.
      if (form.__locked) { e.preventDefault(); return; }
      var message = form.getAttribute('data-confirm');
      if (!message) return;
      // Hold the native submit — the dialog decides asynchronously.
      e.preventDefault();
      // A second click while the dialog is open must not queue another one.
      if (form.__confirmAsking) return;
      form.__confirmAsking = true;

      // Destructive gates get the danger styling (red confirm, focus starts
      // on Cancel so a stray Enter can never approve a delete). The label
      // mirrors the action: delete / remove-student / finalize; anything
      // else (e.g. clone/confirm) is a plain primary confirm.
      var action = (form.getAttribute('action') || '').split('?')[0];
      var last = action.split('/').filter(Boolean).pop() || '';
      var danger = last === 'delete' || last === 'remove-student' || last === 'finalize';
      var confirmLabel = last === 'delete' ? 'Delete'
        : last === 'remove-student' ? 'Remove'
        : last === 'finalize' ? 'Finalize'
        : 'Confirm';

      ConfirmDialog.ask({
        message: message,
        confirmLabel: confirmLabel,
        danger: danger
      }).then(function(ok) {
        form.__confirmAsking = false;
        if (!ok) return;
        if (typeof form.requestSubmit === 'function') {
          // Re-fire a REAL submit event so every other listener (page
          // validation, the double-submit lock) runs exactly as if the user
          // had clicked — form.submit() would skip them all.
          form.__confirmBypass = true;
          form.requestSubmit();
        } else {
          // Ancient engines without requestSubmit: submit() fires no event,
          // so apply the same lock by hand before navigating (M2 pattern).
          lockForm(form);
          form.submit();
        }
      });
    });
  });

  document.querySelectorAll('form[method="POST" i]').forEach(function(form) {
    form.addEventListener('submit', function(e) {
      // Respect a cancel from the data-confirm gate above — if it called
      // preventDefault, the form is not actually submitting, so do not lock it.
      if (e.defaultPrevented) return;
      if (form.__locked) { e.preventDefault(); return; }
      lockForm(form);
    });
  });

  // Returning to a cached page (browser Back) must unlock the form and re-arm
  // the confirm gate, otherwise the user could never re-submit it (or would
  // skip the dialog on a stale bypass flag).
  window.addEventListener('pageshow', function(e) {
    if (!e.persisted) return;
    document.querySelectorAll('form[method="POST" i], form[data-confirm]').forEach(function(form) {
      form.__locked = false;
      form.__confirmBypass = false;
      form.__confirmAsking = false;
      form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(function(btn) {
        btn.disabled = false;
      });
    });
  });
});