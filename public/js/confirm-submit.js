// Attaches a native confirm() gate to any form carrying a data-confirm="message"
// attribute. Replaces inline onsubmit="return confirm(...)" handlers, which are
// blocked by the CSP script-src-attr 'none' directive. Loaded globally via
// views/partials/foot.ejs; inert on pages that have no [data-confirm] form.
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('form[data-confirm]').forEach(function(form) {
    form.addEventListener('submit', function(e) {
      var message = form.getAttribute('data-confirm');
      if (message && !window.confirm(message)) {
        e.preventDefault();
      }
    });
  });
});
