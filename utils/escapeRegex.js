/**
 * B-12 / B-13 — escape user-supplied text before it becomes a $regex pattern.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nineteen search boxes across this app build a MongoDB regex filter by
 * interpolating raw request text, e.g.
 *
 *     filter.name = { $regex: name, $options: "i" }
 *
 * The value is treated as a PATTERN, not as text. A user who types `(` gets a
 * pattern, not a parenthesis. Before this file, three sites had independently
 * hand-rolled a fix for exactly that (`escapeRe` in income/expenseHead.service.js
 * and an inline `.replace(...)` in feeHead.service.js) while the other nineteen
 * had none — the classic outcome of not sharing the helper. This is the shared
 * one.
 *
 * Census (grep of every $regex in the app source, excluding tests and tmp/):
 * 25 occurrences = 19 unescaped user-text + 3 already hand-escaped + 3 static
 * literals (`/^tuition$/i`, the two migration scripts) that take no input and
 * need nothing. The audit report named 21 sites; 19 is what is actually open.
 *
 * WHAT WAS ACTUALLY MEASURED (tmp/_probe_regex_behaviour.js, verify DB)
 * --------------------------------------------------------------------
 *   Malformed patterns — 5/5 threw MongoServerError ("Regular expression is
 *   invalid: missing closing parenthesis", "…missing terminating ] for character
 *   class", "quantifier does not follow a repeatable item"). What that becomes
 *   for the user depends on which layer catches it, and it is worse than a plain
 *   500 in two ways:
 *     • The view routes (/students, /fees, /families, /staff) wrap their whole
 *       handler in try/catch and render the page with an EMPTY list and
 *       `loadError: err.message`. So the user gets HTTP 200 saying "nothing
 *       matched" while the MongoDB driver's internal wording is echoed into the
 *       HTML. A teacher searching for a pupil recorded as "Ali (Junior)" sees no
 *       error — they see an empty roster and reasonably conclude the pupil is
 *       missing. This exact outcome (200 + empty list + leaked wording) is
 *       reproduced and asserted in tmp/_verify_b12_regex.js section G.
 *     • controllers/academic/attendance.controller.js catches to a 400 and puts
 *       `error.message` in the JSON body, so the API leaks the same wording.
 *   Either way the DB's own error text reaches the browser, which is a small
 *   information-disclosure issue in its own right (flagged, not fixed here).
 *   This is reachable BY ACCIDENT, not only by attack: ordinary punctuation in
 *   a name is enough.
 *
 *   Functional correctness — a stored name containing regex syntax became
 *   unsearchable. Searching "a+b" for the pupil literally named `a+b` returned
 *   0 documents; escaped, it returned the 1 correct document. Same for "x(y)".
 *
 *   Match-set widening — ".*" matched 7/7 seeded documents, "[a-z]" matched 6,
 *   "a.*b" matched 2. An attacker-supplied pattern can therefore force a
 *   whole-collection regex scan and pull back rows a literal search would not
 *   have returned. Always inside the caller's own role scope — this is not an
 *   authorisation bypass — but it is unbounded work on a shared-tier database.
 *
 *   ReDoS — NOT demonstrated, and deliberately not claimed. `(a+)+b`, `(a|a)*b`
 *   and `(aa+)+b` each completed against subjects up to 30 chars in ~71 ms
 *   (tmp/_probe_redos.js): MongoDB's engine bounds its own backtracking. The Node
 *   engine does grow 2^n (16→6 ms, 22→78 ms), but in these code paths
 *   `new RegExp` only COMPILES the pattern — the server executes the match — so
 *   no JS-side blowup is reachable here. Escaping still removes the pattern class
 *   entirely, which is the right place to sit.
 *
 * TWO FUNCTIONS, BECAUSE THERE ARE TWO JOBS
 * -----------------------------------------
 *   escapeRegex()      search-as-you-type: escape the metacharacters, keep the
 *                      existing UNANCHORED substring semantics. Escaping must not
 *                      add anchors — searching "Ali" is supposed to return
 *                      "Ali Khan" and "Aliya Bibi".
 *   escapedRegExp()    exact name dedupe (fee/income/expense heads): anchored
 *                      whole-string match, returned as a RegExp because callers
 *                      and tests depend on `$regex` being a RegExp.
 *
 * NOTE ON THE EMPTY STRING: an empty pattern matches EVERYTHING. escapeRegex()
 * returns "" only for null/undefined, and every call site is behind a truthiness
 * guard (`if (name) …`). Do not use it unconditionally on a value that may be
 * absent, or you will trade a regex bug for a full-collection match.
 */

// Standard JS regex metacharacter set. `/` is intentionally absent: these
// patterns are built with `new RegExp`/`$regex` strings, never a /literal/, so
// escaping it would only add noise. `-` is absent because it is only special
// inside a character class, which the escape makes impossible to form anyway.
const META = /[.*+?^${}()|[\]\\]/g;

/**
 * Escape a primitive for literal use inside a regex pattern.
 *
 * NEVER THROWS. That is a deliberate production choice, not laziness: these
 * values come straight off `req.query`, and a helper that threw on a malformed
 * request would turn a wrong-results bug into a fresh 500 path — trading a
 * security fix for an availability regression. Every input instead produces a
 * pattern, and the object case fails CLOSED by construction (see below).
 *
 * @param {*} value user-supplied text
 * @returns {string} the text with every metacharacter backslash-escaped
 */
function escapeRegex(value) {
  if (typeof value === "string") return value.replace(META, "\\$&");
  if (value === null || value === undefined) return "";
  // Non-primitives land here — e.g. `?rollNumber[$ne]=1` arrives as an object.
  // String() of that is "[object Object]", which unescaped is a VALID character
  // class matching almost any stored row: the widening this file exists to stop.
  // Escaping it turns the same value into the literal text `\[object Object\]`,
  // which no real name or roll number equals, so the query returns nothing.
  // Failing closed without throwing is the outcome we want.
  //
  // number / bigint / boolean are legitimate too (roll numbers are often
  // numeric), so everything that reaches here is stringified then escaped.
  return String(value).replace(META, "\\$&");
}

/**
 * Escape and anchor: the WHOLE stored value must equal the supplied text.
 * Used by the fee/income/expense head dedupe, where "is this name taken?" has to
 * mean exactly that and not "does it contain this somewhere?".
 */
function escapedRegExp(value, flags = "i") {
  return new RegExp(`^${escapeRegex(value)}$`, flags);
}

module.exports = { escapeRegex, escapedRegExp };
