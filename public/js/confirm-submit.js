// Two related jobs, both loaded globally via views/partials/foot.ejs:
//
//  1. A native confirm() gate for any form carrying data-confirm="message".
//     Replaces inline onsubmit="return confirm(...)" handlers, which are blocked
//     by the CSP script-src-attr 'none' directive.
//
//  2. Double-submit protection for EVERY POST form. These forms are plain HTML
//     posts that navigate away on submit (the server redirects back), so once a
//     submission is in flight a second click can only fire a duplicate request —
//     historically the cause of two byte-identical records (e.g. a test created
//     twice on the same date, or a week cloned twice). We lock the form after a
//     genuine submit and disable its submit button; a later "pageshow" from the
//     back/forward cache unlocks it so navigating back to re-submit still works.
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('form[data-confirm]').forEach(function(form) {
    form.addEventListener('submit', function(e) {
      var message = form.getAttribute('data-confirm');
      if (message && !window.confirm(message)) {
        e.preventDefault();
      }
    });
  });

  document.querySelectorAll('form[method="POST" i]').forEach(function(form) {
    form.addEventListener('submit', function(e) {
      // Respect a cancel from the data-confirm gate above — if it called
      // preventDefault, the form is not actually submitting, so do not lock it.
      if (e.defaultPrevented) return;
      if (form.__locked) { e.preventDefault(); return; }
      form.__locked = true;
      // Hard-block a second click: disable the submit control while the POST is
      // in flight. The label is left untouched (a disabled button still reads).
      form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(function(btn) {
        btn.disabled = true;
      });
    });
  });

  // Returning to a cached page (browser Back) must unlock the form, otherwise
  // the user could never re-submit it.
  window.addEventListener('pageshow', function(e) {
    if (!e.persisted) return;
    document.querySelectorAll('form[method="POST" i]').forEach(function(form) {
      form.__locked = false;
      form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(function(btn) {
        btn.disabled = false;
      });
    });
  });
});
