// Shared HTML escaper for client-side templates that interpolate
// user-controlled data (OCR extraction results, spreadsheet imports,
// stored names) into innerHTML strings.
//
// Character-mapping (not the div/innerHTML DOM trick) because these strings
// are injected into BOTH text positions and quoted attribute values — the DOM
// trick leaves " and ' intact, which is one value away from an attribute
// breakout (e.g. `<option value="${...}">`).
//
// Loaded as a plain script before the UI modules that call window.escapeHtml.
(function () {
  var ESCAPE_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;",
  };

  window.escapeHtml = function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/[&<>"'`]/g, function (ch) {
      return ESCAPE_MAP[ch];
    });
  };
})();
