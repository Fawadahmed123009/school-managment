/**
 * B-12 / B-13 — regex injection via unescaped $regex interpolation.
 *
 * Three things are proved here, and the third is the one that keeps the fix
 * alive:
 *
 *  1. escapeRegex()/escapedRegExp() behave correctly as pure functions.
 *  2. The two named vulnerable sites really were vulnerable, reproduced by
 *     rendering the OLD expression next to the NEW one — so the tests cannot
 *     pass vacuously.
 *  3. A CENSUS over the actual source: every `$regex` in the app is either
 *     escaped or a static literal with no interpolated input. The task was
 *     "fix all of them, not just the two named"; without this test a new
 *     unescaped search box added next month silently reopens the class.
 */
const fs = require("fs");
const path = require("path");
const { escapeRegex, escapedRegExp } = require("../utils/escapeRegex");

const ROOT = path.join(__dirname, "..");

// ── 1. the helper ────────────────────────────────────────────────────────────
describe("escapeRegex — metacharacters become literal", () => {
  test.each([
    ["Ali", "Ali"],                       // plain text untouched (CRITICAL: no anchors added)
    ["a+b", "a\\+b"],
    ["x(y)", "x\\(y\\)"],
    ["1*2", "1\\*2"],
    ["[a-z]", "\\[a-z\\]"],              // `-` is deliberately NOT escaped: it is
                                          // only special inside a class we make
                                          // impossible to form by escaping `[`
    ["a.b", "a\\.b"],
    ["^start", "\\^start"],
    ["end$", "end\\$"],
    ["q?x", "q\\?x"],
    ["a|b", "a\\|b"],
    ["(a+)+b", "\\(a\\+\\)\\+b"],         // the classic ReDoS shape, defanged
    ["\\back", "\\\\back"],
    ["${}()", "\\$\\{\\}\\(\\)"],
  ])("escapeRegex(%j) === %j", (input, expected) => {
    expect(escapeRegex(input)).toBe(expected);
  });

  test("the escaped output always compiles as a valid RegExp", () => {
    // The pre-fix bug was that arbitrary user text produced an INVALID pattern.
    // Whatever the input, the escaped result must be compilable.
    const hostile = ["[", "(", "a|(", "*", "+=", "(a+)+b", "[a-", "\\", "{$", ")", "?", "+", "((("];
    for (const h of hostile) {
      expect(() => new RegExp(escapeRegex(h), "i")).not.toThrow();
    }
  });

  test("escaping does NOT add anchors — substring search semantics survive", () => {
    // Searching "Ali" must still match "Ali Khan". A well-meaning "secure"
    // helper that anchored everything would break every search box in the app.
    const re = new RegExp(escapeRegex("Ali"), "i");
    expect(re.test("Ali Khan")).toBe(true);
    expect(re.test("Aliya Bibi")).toBe(true);
    expect(re.test("Zaid")).toBe(false);
  });

  test("a metacharacter in the query matches only the literal, not a pattern", () => {
    const re = new RegExp(escapeRegex("a+b"), "i");
    expect(re.test("a+b")).toBe(true);    // the literal text
    expect(re.test("aab")).toBe(false);   // what the unescaped pattern matched
    expect(re.test("ab")).toBe(false);
  });

  test(".* no longer matches everything", () => {
    const re = new RegExp(escapeRegex(".*"), "i");
    expect(re.test("Zaid")).toBe(false);
    expect(re.test(".*")).toBe(true);
  });

  describe("non-string input never throws (a throw would be a new 500 path)", () => {
    test("numbers are coerced and escaped", () => {
      expect(escapeRegex(12345)).toBe("12345");
      expect(escapeRegex(1.5)).toBe("1\\.5");
    });
    test("null/undefined yield the empty string", () => {
      expect(escapeRegex(null)).toBe("");
      expect(escapeRegex(undefined)).toBe("");
    });
    test("an object FAILS CLOSED rather than widening", () => {
      // ?rollNumber[$ne]=1 arrives as an object. Unescaped, String() of it is
      // "[object Object]" — a VALID character class matching almost every row.
      // Escaped, it is a literal that nothing matches.
      const escaped = escapeRegex({ $ne: "1" });
      expect(escaped).toBe("\\[object Object\\]");
      const re = new RegExp(escaped, "i");
      for (const real of ["Ali Khan", "12345", "R-1", "Zaid", "object"]) {
        expect(re.test(real)).toBe(false);
      }
    });
    test("an array does not match everything either", () => {
      const re = new RegExp(escapeRegex(["Ali", "Zaid"]), "i");
      expect(re.test("Ali Khan")).toBe(false);
    });
  });
});

describe("escapedRegExp — anchored exact match, still a RegExp object", () => {
  test("anchored so a head name is matched exactly", () => {
    const re = escapedRegExp("Tuition");
    expect(re.test("Tuition")).toBe(true);
    expect(re.test("tuition fee")).toBe(false);
    expect(re.test("Advanced Tuition")).toBe(false);
  });
  test("escapes AND anchors", () => {
    const re = escapedRegExp("40%+ (Term 1)");
    expect(re.test("40%+ (Term 1)")).toBe(true);
    expect(re.test("40%+ (Term 1)xx")).toBe(false);
  });
  test("returns a RegExp, because callers and existing tests read .$regex.source/flags", () => {
    const re = escapedRegExp("a+b");
    expect(re).toBeInstanceOf(RegExp);
    expect(re.flags).toContain("i");
    expect(re.source).toContain("\\+");
  });
  test("flags are overridable", () => {
    expect(escapedRegExp("x", "").flags).toBe("");
  });
});

// ── 2. the named sites, before vs after ──────────────────────────────────────
describe("B-12 named sites — reproduce the old expression to prove the test bites", () => {
  const HOSTILE = ["[", "(", "a|(", "*", "+="];

  test("attendance.service roll/name search: OLD form produced invalid patterns", () => {
    // OLD: { $regex: name, $options: "i" } — the server compiles `name` as a
    // pattern. Simulate the compile step that MongoDB performs.
    for (const payload of HOSTILE) {
      expect(() => new RegExp(payload, "i")).toThrow();       // old: blows up
      expect(() => new RegExp(escapeRegex(payload), "i")).not.toThrow(); // new: fine
    }
  });

  test("feeHead.service:14 OLD form interpolated raw into a template literal", () => {
    // OLD: new RegExp(`^${name}$`, "i")
    const old = (name) => new RegExp(`^${name}$`, "i");
    const now = (name) => escapedRegExp(name);

    // (a) GENUINELY unbalanced input fails to compile at all.
    expect(() => old("Tuition (Term 1")).toThrow(SyntaxError);
    expect(() => old("[a-")).toThrow(SyntaxError);
    expect(() => now("Tuition (Term 1)")).not.toThrow();
    expect(() => now("[a-")).not.toThrow();

    // (b) THE SNEAKIER BUG, AND THE REASON THIS SITE MATTERS: a name that is
    // valid regex syntax compiles happily and then fails to match ITS OWN
    // LITERAL. The dedupe lookup therefore answers "no such head" about a head
    // that exists, and a duplicate is created. That is silent data corruption,
    // not an error page — and it is not covered by (a).
    for (const name of ["40%+ (Term 1)", "Tuition (Term 1)*", "a+b", "x(y)"]) {
      expect(old(name).test(name)).toBe(false);   // old: dedupe MISSES
      expect(now(name).test(name)).toBe(true);    // new: dedupe HITS
    }

    // (b2) The opposite failure, same root cause. `.` is a metacharacter that
    // happily matches its own literal, so "Fee.2" DOES match itself — and also
    // matches "Feex2" and "FeeX2". The old form over-matches, meaning creating
    // a head called "Feex2" would have been rejected as a duplicate of "Fee.2".
    expect(old("Fee.2").test("Fee.2")).toBe(true);   // not a miss here…
    expect(old("Fee.2").test("Feex2")).toBe(true);   // …but a false collision
    expect(now("Fee.2").test("Feex2")).toBe(false);  // escaped: exact only

    // (c) Widening: the old form read ".*" as "every head is taken".
    expect(old(".*").test("Anything At All")).toBe(true);
    expect(now(".*").test("Anything At All")).toBe(false);
  });

  test("the source no longer contains the old raw interpolations", () => {
    const fee = fs.readFileSync(path.join(ROOT, "services/fees/feeHead.service.js"), "utf8");
    expect(fee).not.toMatch(/new RegExp\(`\^\$\{name\}\$`/);
    const att = fs.readFileSync(path.join(ROOT, "services/academic/attendance.service.js"), "utf8");
    expect(att).not.toMatch(/\$regex: name\b/);
    expect(att).not.toMatch(/\$regex: String\(rollNumber\)/);
  });
});

// ── 3. the census ────────────────────────────────────────────────────────────
describe("B-13 census — every $regex in the app is escaped or static", () => {
  const DIRS = ["routes", "services", "controllers", "models", "middlewares", "handlers", "utils", "app", "config"];

  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, out);
      else if (entry.name.endsWith(".js")) out.push(p);
    }
    return out;
  };

  const files = DIRS.filter((d) => fs.existsSync(path.join(ROOT, d)))
    .flatMap((d) => walk(path.join(ROOT, d)));

  // A $regex is acceptable only if it escapes its input, or is a literal that
  // contains no interpolated value at all.
  const ESCAPED = /escapeRegex\(|escapedRegExp\(/;
  const STATIC = /\$regex:\s*(\/(?:[^/\\\n]|\\.)*\/[a-z]*|"[^"${]*"|'[^'${]*')/;

  const offenders = [];
  const seen = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("$regex:")) return;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // comment
      const rel = path.relative(ROOT, file);
      seen.push(`${rel}:${i + 1}`);
      if (!ESCAPED.test(line) && !STATIC.test(line)) {
        offenders.push(`${rel}:${i + 1}  ${trimmed}`);
      }
    });
  }

  test("the census actually looked at something", () => {
    // Guard against the census silently scanning zero files (a wrong DIRS list
    // would otherwise report a clean app).
    expect(seen.length).toBeGreaterThanOrEqual(22);
  });

  test("no $regex site interpolates unescaped input", () => {
    expect(offenders).toEqual([]);
  });

  test("all 22 dynamic $regex sites go through the helper", () => {
    let escaped = 0;
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.includes("$regex:")) continue;
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (ESCAPED.test(line)) escaped++;
      }
    }
    // 19 formerly-open sites + 3 that were already hand-escaped and are now
    // routed through the shared helper = 22 dynamic $regex sites.
    expect(escaped).toBe(22);
  });

  test("the static literals left alone are only the ones that take no input", () => {
    const statics = [];
    for (const file of files) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (line.includes("$regex:") && !ESCAPED.test(line) && STATIC.test(line)) {
          statics.push(line.trim());
        }
      }
    }
    // Only two remain inside the scanned dirs: the tuition-head lookup. The
    // migration scripts live at the repo root / scripts/ and are not scanned.
    expect(statics.every((s) => /\/\^tuition\$\/i/.test(s))).toBe(true);
  });
});
