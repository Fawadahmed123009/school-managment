// Admin/manager Test Analytics page (/tests/analytics) — unified filter
// cascade bootstrap.
//
// Reuses the PDF Reports page's shared cascade (public/js/report-filter-cascade.js)
// with a fresh 'ax' element-id / submit-name prefix over the same
// views/reports/partials/filter-cascade.ejs markup, scoped to the admin/manager
// (unrestricted) option lists the view route renders. The 'rs' / 'an' / 'sr'
// auto-inits inside the shared file no-op here because those elements do not
// exist on this page.
//
// Unlike the PDF form (POST → separate result page), this page re-renders
// itself via GET, so the just-applied filters must survive the reload. The
// view route embeds them as #ax-filter-state; `initReportFilterCascade`
// pre-applies the state (pending grade/section until their options exist) and
// the initial rebuild keeps every still-valid choice, clearing anything the
// chain no longer offers.
(function () {
  if (typeof window.initReportFilterCascade !== 'function') return;

  var state = {};
  try {
    var el = document.getElementById('ax-filter-state');
    if (el) state = JSON.parse(el.textContent) || {};
  } catch (e) { state = {}; }

  window.initReportFilterCascade('ax', state);
})();
