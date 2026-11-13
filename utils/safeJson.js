/**
 * B-14 — safe JSON embedding for EJS data islands.
 *
 * The problem
 * -----------
 * Templates that ship chart/config data as `<script type="application/json">
 * <%- JSON.stringify(x) %></script>` are NOT protected by EJS escaping — `<%-`
 * is the raw sink. `JSON.stringify` escapes quotes and backslashes, but it
 * leaves `<` and `>` completely literal. So any stored value containing
 * `</script>` (a student's name, a fee head, an income source, a test session
 * name…) terminates the script element early and the remainder of the string
 * becomes live markup in the page. That is stored XSS reaching a raw sink on
 * every dashboard, report and picker that uses this pattern.
 *
 * The two ad-hoc guards found in the codebase were both inadequate:
 *   • most sites had no guard at all, and
 *   • `views/parents/dashboard.ejs` used `.replace(/</g, '\u003c')` — in a JS
 *     string literal `'\u003c'` *is* the character `<`, so that replace is a
 *     silent no-op that looks like a fix. Only the `'\\u003c'` spelling works.
 *
 * The fix
 * -------
 * One serializer, so the rule is stated once and cannot be re-forgotten:
 *   safeJson()     → for `<script type="application/json">` islands and for
 *                    JSON spliced into a JS object literal.
 *   safeJsonAttr() → additionally entity-quotes `&`, `'` and `"` for values
 *                    placed inside an HTML attribute (e.g. `data-phases='…'`),
 *                    which the HTML parser hands back decoded to JSON.parse.
 *
 * Both emit standard JSON `\uXXXX` escapes, so what the client reads is
 * byte-identical to the original data — `JSON.parse` is unaffected, and no
 * consumer needs to change.
 *
 * `<` and `>` are the load-bearing escapes (`</script>`, `<!--`, `-->`).
 * U+2028 / U+2029 are escaped as defence in depth: ES2019 made them legal inside
 * JavaScript string literals, so current browsers are not broken by them, but
 * older WebViews and any hand-rolled `eval` of the island still treat them as
 * line terminators. Escaping costs nothing and is JSON-legal either way.
 *
 * Failure policy: never throw. A circular reference or BigInt must not turn a
 * page render into a 500, so an unserializable value becomes the JSON literal
 * `null`, which every consumer here already guards against (`… || []`).
 */

// Characters that must never appear literally inside a <script> element body
// or a JS source literal. Mapped to their \uXXXX form.
const SCRIPT_UNSAFE = {
  "<": "\\u003c",
  ">": "\\u003e",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * Serialize `value` so it can be embedded with `<%- … %>` inside a
 * `<script type="application/json">` block, or as a value inside a JS object
 * literal, without ever closing the script element or breaking the literal.
 *
 * @param {*} value
 * @returns {string} valid JSON, with < > U+2028 U+2029 escaped
 */
function safeJson(value) {
  let out;
  try {
    out = JSON.stringify(value);
  } catch (_) {
    // circular structure, BigInt, replacer throw — degrade, never 500
    return "null";
  }
  // JSON.stringify(undefined) and a top-level undefined both yield `undefined`
  // (the value, not a string); "null" keeps the island parseable.
  if (out === undefined) return "null";
  return out.replace(/[<>\u2028\u2029]/g, (ch) => SCRIPT_UNSAFE[ch]);
}

/**
 * Serialize `value` for embedding inside an HTML attribute value, e.g.
 *   <option data-phases='<%- safeJsonAttr(s.phases) %>'>
 *
 * Builds on safeJson (so the script-breaking characters are already gone) and
 * then entity-quotes the three characters that can terminate or corrupt an
 * attribute: `&` first (so the entities added afterwards are not re-encoded),
 * then the two quote characters. The HTML parser decodes them again before the
 * value reaches `JSON.parse` / `dataset`, so the client still receives the
 * exact original data.
 *
 * MUST be used with the raw `<%-` tag: the helper owns the whole escaping
 * contract, and EJS's `<%=` would escape the `&` of our own entities a second
 * time (`&amp;quot;`), corrupting the JSON.
 *
 * @param {*} value
 * @returns {string} HTML-attribute-safe JSON, for the `<%-` tag
 */
function safeJsonAttr(value) {
  return safeJson(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { safeJson, safeJsonAttr };
