/**
 * B-14 — safeJson / safeJsonAttr: the only two places a `<%- … %>` raw sink may
 * receive JSON-produced markup.
 *
 * The vulnerability being pinned is a STORED value reaching a raw EJS sink
 * inside a <script> element. `JSON.stringify` escapes quotes and backslashes
 * but leaves `<` and `>` literal, so a name like `</script><img onerror=…>`
 * closes the script element and the markup executes. An attacker does not need
 * a quote or a tag opener — `</script>` alone is the breakout.
 *
 * Also pinned here, because it was the trap that let this class survive a
 * previous pass: the ad-hoc guard `.replace(/</g, '\u003c')` (single backslash)
 * is a silent NO-OP — in a JS string literal `'\u003c'` *is* `<`. Only the
 * `'\\u003c'` spelling escaped anything. safeJson removes the hand-rolled
 * variants entirely.
 *
 * Contract proven below, in order:
 *   1. the exact production payload breaks out pre-fix and is inert post-fix,
 *   2. output is always valid JSON that round-trips to the original data,
 *   3. the JS-literal hazard (U+2028/2029) is covered,
 *   4. attribute mode neutralises quote/& breakouts and still decodes back,
 *   5. nothing ever throws out of a render.
 */
const ejs = require("ejs");
const fs = require("fs");
const path = require("path");

const { safeJson, safeJsonAttr } = require("../utils/safeJson");

const PAYLOAD = '</script><img src=x onerror="alert(1)">';
const XSS_ATTR = "' onmouseover='alert(1)";

// ── 1. the stored-XSS payload, pre-fix vs post-fix ───────────────────────────
describe("B-14 — </script> breakout in a JSON data island", () => {
  const template = `<script type="application/json" id="d"><%- JSON.stringify(data) %></script>`;

  it("reproduces the vulnerability through the raw pattern it replaces", () => {
    // Non-vacuity guard: proves the test would fail if safeJson were a no-op.
    const rendered = ejs.render(template, { data: { name: PAYLOAD } });
    const openTags = (rendered.match(/<script/g) || []).length;
    const closeTags = (rendered.match(/<\/script>/g) || []).length;
    expect(openTags).toBe(1);
    expect(closeTags).toBe(2);            // the payload closed the element
    expect(rendered).toContain("<img src=x onerror=");  // live markup escaped
  });

  it("safeJson renders exactly one script element and no injected markup", () => {
    const fixed = `<script type="application/json" id="d"><%- safeJson(data) %></script>`;
    const rendered = ejs.render(fixed, { data: { name: PAYLOAD }, safeJson });
    expect((rendered.match(/<script/g) || []).length).toBe(1);
    expect((rendered.match(/<\/script>/g) || []).length).toBe(1);
    // The island body must contain no angle bracket at all — that is what
    // makes the payload inert. Its words still appear, as JSON data.
    const island = rendered.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect(island).not.toMatch(/[<>]/);
    expect(JSON.parse(island).name).toBe(PAYLOAD);
  });

  it("still parses back to the exact original value", () => {
    const rendered = ejs.render(
      `<script type="application/json" id="d"><%- safeJson(data) %></script>`,
      { data: { name: PAYLOAD, n: 1 }, safeJson }
    );
    const island = rendered.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect(JSON.parse(island)).toEqual({ name: PAYLOAD, n: 1 });
  });

  it("neutralises <!-- and --> comment-style script-data breakouts too", () => {
    const out = safeJson({ c: "--><script>alert(1)</script>" });
    expect(out).not.toMatch(/[<>]/);
    expect(JSON.parse(out).c).toBe("--><script>alert(1)</script>");
  });
});

// ── 2. output is always valid JSON ───────────────────────────────────────────
describe("B-14 — safeJson emits valid JSON", () => {
  const cases = [
    ["string", "plain"],
    ["nested quotes", 'he said "hi" and \'bye\''],
    ["backslash", "C:\\path\\to\\file"],
    ["unicode", "café — 乌尔都 — 🎓"],
    ["array", [1, "two", { three: 3 }, null, true]],
    ["empty object", {}],
    ["empty array", []],
    ["number", 42],
    ["zero and negative", -0.5],
    ["boolean", true],
    ["null", null],
    ["date as string", "2026-11-13T00:00:00.000Z"],
    ["html fragment", "<div class='a'>&amp;</div>"],
  ];

  it.each(cases)("%s round-trips identically", (_label, value) => {
    const out = safeJson(value);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it("leaves ordinary JSON untouched (no over-escaping of safe data)", () => {
    expect(safeJson({ a: 1, b: "text" })).toBe('{"a":1,"b":"text"}');
  });

  it("escapes angle brackets only inside the serialized text", () => {
    const out = safeJson("<a>");
    expect(out).toBe('"\\u003ca\\u003e"');
    expect(JSON.parse(out)).toBe("<a>");
  });
});

// ── 3. the JavaScript-source hazard ──────────────────────────────────────────
describe("B-14 — U+2028 / U+2029 (escaped as defence in depth)", () => {
  it("escapes both separators and the data still round-trips", () => {
    // Note: ES2019 legalised U+2028/U+2029 inside JS string literals, so this
    // is defence in depth for older engines rather than a live break — see
    // utils/safeJson.js. The escape must stay JSON-identical, which is what
    // this test pins.
    const out = safeJson({ s: "a\u2028b\u2029c" });
    expect(out).not.toContain("\u2028");
    expect(out).not.toContain("\u2029");
    expect(JSON.parse(out)).toEqual({ s: "a\u2028b\u2029c" });
  });

  it("the escaped form is a single-line, whitespace-safe literal", () => {
    // An island containing a raw line separator is a hazard for anything that
    // re-parses the emitted text line-by-line (minifiers, old WebViews). The
    // escape guarantees the output never contains a literal newline source.
    const out = safeJson("a\u2028b\u2029c");
    expect(out.split("\n").length).toBe(1);
    expect(out).toBe('"a\\u2028b\\u2029c"');
    expect(JSON.parse(out)).toBe("a\u2028b\u2029c");
  });
});

// ── 4. HTML attribute context ────────────────────────────────────────────────
describe("B-14 — safeJsonAttr for data-phases / data-classes / data-cpicker-selected", () => {
  it("contains no character that can close a quoted attribute", () => {
    const out = safeJsonAttr([{ name: XSS_ATTR }, { n: 'a"b' }]);
    expect(out).not.toContain("'");
    expect(out).not.toContain('"');
    expect(out).not.toMatch(/[<>]/);
    // Every `&` must be the start of one of our own entities.
    expect(out.replace(/&(?:amp|quot|#39);/g, "")).not.toContain("&");
    // And the payload's own words are neutralised as data, not markup.
    expect(out).not.toContain("<img");
  });

  // Strips every quoted value from an opening tag so only the real attribute
  // names remain. Without this, a payload word inside a value ("…' onmouseover=")
  // would look like an injected attribute to a naive regex.
  const attributeNames = (tag) => {
    const outside = tag.replace(/"[^"]*"|'[^']*'/g, "");
    // `\s(name)=` — drop both the leading whitespace and the trailing `=`.
    return (outside.match(/\s([a-zA-Z-]+)=/g) || []).map((s) => s.trim().replace(/=$/, ""));
  };

  it("reproduces the attribute breakout through the raw pattern it replaces", () => {
    // Non-vacuity guard for the structural assertions below: the raw sink lets
    // the payload terminate the value early and inject a real second attribute.
    const tpl = `<option data-phases='<%- JSON.stringify(phases) %>'>x</option>`;
    const rendered = ejs.render(tpl, { phases: [{ name: XSS_ATTR, order: 1 }] });
    const openTag = rendered.match(/^<option[^>]*>/)[0];
    expect(openTag.split("'").length).toBe(5);                    // value terminated twice early
    expect(attributeNames(openTag)).toEqual(["data-phases", "onmouseover"]);
  });

  it("survives a full render → DOM-attribute → JSON.parse round trip", () => {
    const tpl = `<option data-phases='<%- safeJsonAttr(phases) %>'>x</option>`;
    const phases = [{ name: XSS_ATTR, order: 1 }];
    const rendered = ejs.render(tpl, { phases, safeJsonAttr });
    const openTag = rendered.match(/^<option[^>]*>/)[0];
    // The breakout test is structural, not textual: the payload's words will
    // still appear *inside* the quoted attribute value as inert data. What must
    // not happen is the value terminating early and a SECOND attribute (or a
    // second element) appearing.
    expect((rendered.match(/<option/g) || []).length).toBe(1);
    expect(openTag.split("'").length).toBe(3);                    // exactly one quoted value
    expect(attributeNames(openTag)).toEqual(["data-phases"]);      // nothing injected
    // Decode the entities the way an HTML parser would, then parse.
    const attr = rendered.match(/data-phases='([^']*)'/)[1];
    const decoded = attr
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">");
    expect(JSON.parse(decoded)).toEqual(phases);
  });

  it("does not double-encode & (the ordering bug that would corrupt data)", () => {
    const out = safeJsonAttr({ s: "A & B" });
    expect(out).toContain("A &amp; B");
    expect(out).not.toContain("&amp;amp;");
  });
});

// ── 5. failure policy: a render must never 500 ───────────────────────────────
describe("B-14 — never throws out of a template render", () => {
  it("circular reference degrades to null instead of throwing", () => {
    const circ = { a: 1 };
    circ.self = circ;
    expect(() => JSON.stringify(circ)).toThrow();
    expect(safeJson(circ)).toBe("null");
    expect(JSON.parse(safeJson(circ))).toBeNull();
  });

  it("undefined degrades to null (not the bare token `undefined`)", () => {
    expect(safeJson(undefined)).toBe("null");
    expect(() => JSON.parse(safeJson(undefined))).not.toThrow();
  });

  it("a BigInt in a Mongoose-style document degrades rather than crashing", () => {
    expect(safeJson({ big: BigInt(9) })).toBe("null");
  });

  it("the degraded value still renders a well-formed script island", () => {
    const rendered = ejs.render(
      `<script type="application/json" id="d"><%- safeJson(data) %></script>`,
      { data: (() => { const c = {}; c.self = c; return c; })(), safeJson }
    );
    expect(rendered).toBe("<script type=\"application/json\" id=\"d\">null</script>");
  });
});

// ── 6. the migration itself is complete ──────────────────────────────────────
describe("B-14 — every raw JSON sink in views/ now goes through the helper", () => {
  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (p.endsWith(".ejs")) out.push(p);
    }
    return out;
  }
  const files = walk(path.join(__dirname, "..", "views"));
  const sources = files.map((f) => [f, fs.readFileSync(f, "utf8")]);

  it("no template still uses `<%- JSON.stringify(`", () => {
    const offenders = sources.filter(([, t]) => /<%-\s*JSON\.stringify/.test(t)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("no template still carries the hand-rolled `</` guard", () => {
    const offenders = sources.filter(([, t]) => /\.replace\(\s*\/<\/\/g/.test(t)).map(([f]) => path.basename(f));
    expect(offenders).toEqual([]);
  });

  it("the named production sites from the finding are covered", () => {
    const finance = fs.readFileSync(path.join(__dirname, "..", "views", "finance", "report.ejs"), "utf8");
    const rollup = fs.readFileSync(path.join(__dirname, "..", "views", "attendance", "rollup.ejs"), "utf8");
    expect(finance).toMatch(/<%- safeJson\(\{[\s\S]*\}\) %>/);
    expect(rollup).toMatch(/id="weekly-data"><%- safeJson\(weekly\) %>/);
    expect(rollup).toMatch(/id="overview-data"><%- safeJson\(dash\.summary\) %>/);
  });

  it("helpers are reachable from the view layer via app.locals", () => {
    const appSrc = fs.readFileSync(path.join(__dirname, "..", "app", "app.js"), "utf8");
    expect(appSrc).toMatch(/app\.locals\.safeJson\s*=\s*safeJson/);
    expect(appSrc).toMatch(/app\.locals\.safeJsonAttr\s*=\s*safeJsonAttr/);
  });

  it("all templates still compile", () => {
    for (const f of files) {
      expect(() => ejs.compile(fs.readFileSync(f, "utf8"), { filename: f })).not.toThrow();
    }
  });
});
