// Distributes the CSRF token (rendered into <meta name="csrf-token"> by the
// server) to the browser:
//   • exposes it as window.CSRF_TOKEN for fetch()/AJAX callers to send in the
//     X-CSRF-Token header, and
//   • injects it as a hidden `_csrf` field into every POST <form> so plain form
//     submits carry it too.
// No token (e.g. the pre-login pages) → no-op.
(function () {
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta ? meta.getAttribute("content") : "";
  window.CSRF_TOKEN = token;
  if (!token) return;

  function injectIntoForms() {
    var forms = document.querySelectorAll("form[method]");
    for (var i = 0; i < forms.length; i++) {
      var form = forms[i];
      if ((form.getAttribute("method") || "").toLowerCase() !== "post") continue;
      if (form.querySelector('input[name="_csrf"]')) continue; // already server-rendered
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = "_csrf";
      input.value = token;
      form.appendChild(input);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectIntoForms);
  } else {
    injectIntoForms();
  }
})();
