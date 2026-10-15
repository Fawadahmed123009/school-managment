/**
 * Tests for the searchable Student picker.
 *
 * Two layers:
 *   A. public/js/student-typeahead.js — the ONE shared typeahead implementation
 *      (extracted from the Fee add-record selector, now also driving the Student
 *      level of every PDF-report panel): name/roll substring matching, commit on
 *      click/Enter, invalidation while typing, live-pool re-reads, row cap, and
 *      safe DOM row building (stored names can never become markup).
 *   B. public/js/report-filter-cascade.js — proves the picker is scoped, not a
 *      second data path: it searches exactly the pool the cascade just built, so
 *      Session → Grade → Section narrowing and the server-side role scoping of
 *      the rendered options both carry over, a pick still lands in the
 *      submit-bearing <select>, and a pick that falls out of scope is cleared.
 *
 * Both real files are loaded into one Node vm with a minimal DOM stub, in the
 * same order the page loads them.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PUBLIC_JS = path.join(__dirname, "..", "public", "js");

// ── minimal DOM stub ────────────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tagName: tag,
    className: "",
    textContent: "",
    value: "",
    style: {},
    dataset: {},
    disabled: false,
    attrs: {},
    children: [],
    _listeners: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, v) {
      this.attrs[name] = String(v);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    get firstChild() {
      return this.children.length ? this.children[0] : null;
    },
    contains(node) {
      return this.children.some((c) => c === node || (c.contains && c.contains(node)));
    },
    // Only the selector forms the real code uses: 'option',
    // 'option[value=""]' and '.class'.
    querySelectorAll(sel) {
      const opt = /^option\[value="([^"]*)"\]$/.exec(sel);
      if (opt) return this.children.filter((c) => c.tagName === "option" && c.value === opt[1]);
      if (sel.charAt(0) === ".") {
        const cls = sel.slice(1);
        return this.children.filter((c) => (c.className || "").split(" ").indexOf(cls) !== -1);
      }
      return this.children.filter((c) => c.tagName === sel);
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    addEventListener(ev, fn) {
      (this._listeners[ev] = this._listeners[ev] || []).push(fn);
    },
    fire(ev, arg) {
      (this._listeners[ev] || []).forEach((fn) => fn(arg || {}));
    },
  };
  // innerHTML = '' is how the cascade clears a <select>; rows are only ever
  // built with createElement/appendChild, so nothing else is ever parsed.
  Object.defineProperty(el, "innerHTML", {
    get() {
      return "";
    },
    set(v) {
      if (v !== "") throw new Error("stub only supports clearing via innerHTML = ''");
      el.children = [];
      el.value = "";
    },
  });
  return el;
}

// A <select> whose `value` behaves like the browser's: assigning a value with no
// matching option resets it to '' (that is what makes "stale pick is cleared"
// observable in these tests).
function makeSelect(id, optionDefs) {
  const sel = makeEl("select");
  sel.id = id;
  let current = "";
  Object.defineProperty(sel, "options", { get: () => sel.children });
  Object.defineProperty(sel, "value", {
    get: () => current,
    set(v) {
      const hit = sel.children.filter((o) => o.tagName === "option").some((o) => o.value === String(v));
      current = hit ? String(v) : "";
    },
  });
  (optionDefs || []).forEach((def) => {
    const opt = makeEl("option");
    opt.value = def.value;
    opt.textContent = def.label;
    Object.keys(def.attrs || {}).forEach((k) => opt.setAttribute(k, def.attrs[k]));
    sel.appendChild(opt);
  });
  current = "";
  return sel;
}

function buildSandbox(elements) {
  const byId = {};
  Object.keys(elements).forEach((k) => {
    byId[k] = elements[k];
  });
  const document = {
    getElementById: (id) => (Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null),
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const sandbox = {
    document,
    window: {},
    alert: () => {},
    console,
    Number,
    String,
    Object,
    Array,
    JSON,
    Math,
    RegExp,
    Date,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ["student-typeahead.js", "report-filter-cascade.js"].forEach((m) => {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_JS, m), "utf8"), sandbox, { filename: m });
  });
  return sandbox;
}

// Row titles currently rendered in a results box.
const rowTitles = (box) =>
  box.children
    .filter((c) => (c.className || "").indexOf("student-typeahead-item") === 0)
    .map((c) => c.children[0] && c.children[0].textContent);

// ═════════════════════════════════════════════════════════════════════════════
// A. the shared typeahead component
// ═════════════════════════════════════════════════════════════════════════════
describe("student-typeahead — shared searchable picker", () => {
  function harness(pool, opts) {
    const input = makeEl("input");
    const results = makeEl("div");
    const events = { selected: [], invalidated: 0 };
    const sandbox = { window: {}, document: { createElement: (t) => makeEl(t), addEventListener: () => {} }, String, Array, Object };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_JS, "student-typeahead.js"), "utf8"), sandbox, {
      filename: "student-typeahead.js",
    });
    const picker = sandbox.window.initStudentTypeahead(
      Object.assign(
        {
          input,
          results,
          items: () => pool.items,
          onSelect: (item) => events.selected.push(item),
          onInvalidate: () => {
            events.invalidated += 1;
          },
          getSelected: () => events.committed,
        },
        opts || {}
      )
    );
    return { picker, input, results, events, pool };
  }

  const POOL = {
    items: [
      { id: "s1", title: "Ali Khan", label: "Ali Khan (7)", keywords: "ali khan 7", subtitle: "Roll 7 · Grade 9 · Boys" },
      { id: "s2", title: "Sara Malik", label: "Sara Malik (12)", keywords: "sara malik 12", subtitle: "Roll 12 · Grade 9 · Girls" },
      { id: "s3", title: "Bilal Ahmed", label: "Bilal Ahmed (3)", keywords: "bilal ahmed 3", subtitle: "Roll 3 · Grade 10 · Boys" },
    ],
  };

  test("typing a partial name narrows the list to matching pupils", () => {
    const h = harness(POOL);
    h.input.value = "ali kh";
    h.input.fire("input");
    expect(rowTitles(h.results)).toEqual(["Ali Khan"]);
    expect(h.results.style.display).toBe("block");
  });

  test("match is case-insensitive and substring-based (middle of a name works)", () => {
    const h = harness(POOL);
    h.input.value = "KHAN";
    h.input.fire("input");
    expect(rowTitles(h.results)).toEqual(["Ali Khan"]);
    h.input.value = "mal";
    h.input.fire("input");
    expect(rowTitles(h.results)).toEqual(["Sara Malik"]);
  });

  test("roll number searches work, same as the fee picker did", () => {
    const h = harness(POOL);
    h.input.value = "12";
    h.input.fire("input");
    expect(rowTitles(h.results)).toEqual(["Sara Malik"]);
  });

  test("clicking a row commits that pupil and shows its label in the box", () => {
    const h = harness(POOL);
    h.input.value = "sara";
    h.input.fire("input");
    h.results.children[0].fire("click");
    expect(h.events.selected.map((i) => i.id)).toEqual(["s2"]);
    expect(h.input.value).toBe("Sara Malik (12)");
    expect(h.results.style.display).toBe("none");
  });

  test("mousedown commits too (the box must not blur and blank the pick first)", () => {
    const h = harness(POOL);
    h.input.value = "bilal";
    h.input.fire("input");
    const preventDefault = jest.fn();
    h.results.children[0].fire("mousedown", { preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(h.events.selected.map((i) => i.id)).toEqual(["s3"]);
  });

  test("typing invalidates the previous pick, so a half-typed name is never submitted", () => {
    const h = harness(POOL);
    h.input.value = "ali";
    h.input.fire("input");
    h.results.children[0].fire("click");
    h.events.invalidated = 0;
    h.input.value = "ali kha"; // user starts editing the committed name
    h.input.fire("input");
    expect(h.events.invalidated).toBe(1);
  });

  test("emptying the box closes the list and invalidates the pick", () => {
    const h = harness(POOL);
    h.input.value = "ali kh";
    h.input.fire("input");
    h.results.children[0].fire("click");
    h.events.invalidated = 0;
    h.input.value = "   ";
    h.input.fire("input");
    expect(h.results.style.display).toBe("none");
    expect(h.events.invalidated).toBe(1);
  });

  test("blur restores the box to the committed pupil (or blanks it when none)", () => {
    const h = harness(POOL);
    h.events.committed = { id: "s1", label: "Ali Khan (7)" };
    h.input.value = "stray typing";
    h.input.fire("blur");
    expect(h.input.value).toBe("Ali Khan (7)");
    h.events.committed = null;
    h.input.fire("blur");
    expect(h.input.value).toBe("");
  });

  test("Enter commits the highlighted match and never submits the surrounding form", () => {
    const h = harness(POOL);
    h.input.value = "khan";
    h.input.fire("input");
    const ev = { key: "ArrowDown", preventDefault: jest.fn() };
    h.input.fire("keydown", ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(h.results.children[0].className).toContain("is-active");
    const enter = { key: "Enter", preventDefault: jest.fn() };
    h.input.fire("keydown", enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(h.events.selected.map((i) => i.id)).toEqual(["s1"]);
  });

  test("no match leaves an explicit empty state instead of a silent empty list", () => {
    const h = harness(POOL);
    h.input.value = "zebra";
    h.input.fire("input");
    expect(rowTitles(h.results)).toEqual([]);
    expect(h.results.children[0].className).toBe("student-typeahead-empty");
  });

  test("the list is capped, so a huge roster never floods the dropdown", () => {
    const big = { items: Array.from({ length: 60 }, (_, i) => ({ id: "x" + i, title: "Student " + i, keywords: "student " + i })) };
    const h = harness(big);
    h.input.value = "student";
    h.input.fire("input");
    expect(rowTitles(h.results)).toHaveLength(30);
  });

  test("the item source is re-read on every render (upstream narrowing is respected)", () => {
    const pool = { items: POOL.items.slice() };
    const h = harness(pool);
    h.input.value = "ali kh";
    h.input.fire("input");
    expect(rowTitles(h.results)).toEqual(["Ali Khan"]);
    pool.items = [POOL.items[1]]; // Ali drops out of scope upstream
    h.input.fire("input");
    expect(rowTitles(h.results)).toEqual([]);
  });

  test("a stored name containing markup is rendered as text, never parsed", () => {
    const hostile = {
      items: [{ id: "h1", title: '<img src=x onerror="alert(1)">', keywords: "<img src=x onerror=alert(1)>", label: "hostile" }],
    };
    const h = harness(hostile);
    h.input.value = "img";
    h.input.fire("input");
    const row = h.results.children[0];
    expect(row.children[0].tagName).toBe("strong");
    expect(row.children[0].textContent).toBe('<img src=x onerror="alert(1)">');
    expect(row.children[0].innerHTML).toBe(""); // no markup was ever written
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. the picker inside the PDF-report cascade
// ═════════════════════════════════════════════════════════════════════════════
const STU = [
  { id: "stu-ali", name: "Ali Khan", roll: "7", grade: "9", section: "Boys", cls: "c-9b" },
  { id: "stu-sara", name: "Sara Malik", roll: "12", grade: "9", section: "Girls", cls: "c-9g" },
  { id: "stu-bilal", name: "Bilal Ahmed", roll: "3", grade: "10", section: "Boys", cls: "c-10b" },
];

function optionDefs(students) {
  return students.map((s) => ({
    value: s.id,
    label: `${s.name} (${s.roll})`,
    attrs: { "data-grade": s.grade, "data-section": s.section, "data-class": s.cls, "data-name": s.name, "data-roll": s.roll },
  }));
}

// The cascade runs its own init for 'rs'/'an'/'sr' at load, so simply loading
// the file with the three panels' elements present is exactly what the page
// does. Every panel gets the full picker set, matching filter-cascade.ejs ids.
function loadCascade(students, withPicker) {
  const showPicker = withPicker !== false;
  const els = {};
  ["rs", "an", "sr"].forEach((idp) => {
    els[idp + "-session"] = makeSelect(idp + "-session", [{ value: "", label: "-- All sessions --" }]);
    els[idp + "-grade"] = makeSelect(idp + "-grade", [{ value: "", label: "All grades" }]);
    els[idp + "-section"] = makeSelect(idp + "-section", [{ value: "", label: "All sections" }]);
    els[idp + "-student"] = makeSelect(idp + "-student", [{ value: "", label: "All students" }].concat(optionDefs(students)));
    els[idp + "-subject"] = makeSelect(idp + "-subject", [{ value: "", label: "All subjects" }]);
    els[idp + "-test"] = makeSelect(idp + "-test", [{ value: "", label: "All tests" }]);
    els[idp + "-test-count"] = makeEl("p");
    if (showPicker) {
      els[idp + "-student-search"] = makeEl("input");
      els[idp + "-student-results"] = makeEl("div");
      els[idp + "-student-hint"] = makeEl("p");
    }
  });
  els["report-class-scope"] = makeEl("script");
  els["report-class-scope"].textContent = "{}";
  const sandbox = buildSandbox(els);
  return { els, sandbox };
}

describe("PDF-report cascade — searchable Student picker", () => {
  test("searching a partial name lists that pupil and committing writes the select the panel submits", () => {
    const { els } = loadCascade(STU);
    const search = els["rs-student-search"];
    const results = els["rs-student-results"];
    search.value = "sara";
    search.fire("input");
    expect(rowTitles(results)).toEqual(["Sara Malik"]);
    results.children[0].fire("click");
    // Downstream contract: the named select carries the pupil id.
    expect(els["rs-student"].value).toBe("stu-sara");
    expect(els["rs-student-hint"].textContent).toContain("Sara Malik (12)");
  });

  test("a pick survives nothing: typing without selecting clears the select", () => {
    const { els } = loadCascade(STU);
    const search = els["rs-student-search"];
    search.value = "ali kh";
    search.fire("input");
    els["rs-student-results"].children[0].fire("click");
    expect(els["rs-student"].value).toBe("stu-ali");
    search.value = "ali k";
    search.fire("input");
    expect(els["rs-student"].value).toBe(""); // no stale pupil submitted
  });

  test("search is scoped to the current Grade — a pupil in another grade is not findable", () => {
    const { els } = loadCascade(STU);
    const grade = els["rs-grade"];
    const section = els["rs-section"];
    // Grade options are built from the rendered (role-scoped) pool.
    expect(grade.querySelectorAll("option").map((o) => o.value)).toEqual(["", "9", "10"]);
    grade.value = "9";
    grade.fire("change");
    expect(section.querySelectorAll("option").map((o) => o.value)).toEqual(["", "Boys", "Girls"]);

    const search = els["rs-student-search"];
    const results = els["rs-student-results"];
    search.value = "bilal"; // Bilal is grade 10
    search.fire("input");
    expect(rowTitles(results)).toEqual([]);
    search.value = "khan";
    search.fire("input");
    expect(rowTitles(results)).toEqual(["Ali Khan"]);
  });

  test("search is scoped to the current Section as well", () => {
    const { els } = loadCascade(STU);
    const grade = els["rs-grade"];
    const section = els["rs-section"];
    grade.value = "9";
    grade.fire("change");
    section.value = "Girls";
    section.fire("change");

    const search = els["rs-student-search"];
    const results = els["rs-student-results"];
    search.value = "ali kh"; // Ali is grade 9 Boys
    search.fire("input");
    expect(rowTitles(results)).toEqual([]);
    search.value = "sara";
    search.fire("input");
    expect(rowTitles(results)).toEqual(["Sara Malik"]);
  });

  test("changing Grade out from under a committed pick clears both the select and the box", () => {
    const { els } = loadCascade(STU);
    const search = els["rs-student-search"];
    search.value = "sara";
    search.fire("input");
    els["rs-student-results"].children[0].fire("click");
    expect(els["rs-student"].value).toBe("stu-sara");

    const grade = els["rs-grade"];
    grade.value = "10";
    grade.fire("change");
    expect(els["rs-student"].value).toBe("");   // Sara no longer in scope
    expect(search.value).toBe("");              // and the box stopped lying about her
  });

  test("role scoping: the picker only ever searches the options the server rendered", () => {
    // A plain teacher's panel is rendered with ONLY their assigned pupils
    // (GET /pdf-reports/teacher-students). Here that is just Sara.
    const { els } = loadCascade([STU[1]]);
    const search = els["rs-student-search"];
    const results = els["rs-student-results"];
    ["ali kh", "bilal", "khan", "ahmed"].forEach((q) => {
      search.value = q;
      search.fire("input");
      expect(rowTitles(results)).toEqual([]);
    });
    search.value = "sara";
    search.fire("input");
    expect(rowTitles(results)).toEqual(["Sara Malik"]);
  });

  test("all three panels get their own picker (rs / an /sr) with no cross-talk", () => {
    const { els } = loadCascade(STU);
    const anSearch = els["an-student-search"];
    anSearch.value = "bilal";
    anSearch.fire("input");
    expect(rowTitles(els["an-student-results"])).toEqual(["Bilal Ahmed"]);
    expect(els["an-student"].value).toBe("");
    els["an-student-results"].children[0].fire("click");
    expect(els["an-student"].value).toBe("stu-bilal");
    // The other panels are untouched.
    expect(els["rs-student"].value).toBe("");
    expect(els["sr-student"].value).toBe("");
    expect(rowTitles(els["sr-student-results"])).toEqual([]);
  });

  test("a panel without the picker elements still runs the plain cascade", () => {
    // Defensive: student-typeahead.js missing on the page must not kill the
    // Session/Grade/Section/Subject/Test chain.
    const { els } = loadCascade(STU, false);
    const grade = els["rs-grade"];
    expect(grade.querySelectorAll("option").map((o) => o.value)).toEqual(["", "9", "10"]);
    grade.value = "10";
    grade.fire("change");
    expect(els["rs-student"].querySelectorAll("option").map((o) => o.value)).toEqual(["", "stu-bilal"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Page wiring
// ═════════════════════════════════════════════════════════════════════════════
describe("page wiring", () => {
  const root = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

  test("the PDF-report page loads the shared picker before the cascade", () => {
    const src = read("views/reports/generate.ejs");
    const shared = src.indexOf('<script src="/js/student-typeahead.js"></script>');
    const cascade = src.indexOf('<script src="/js/report-filter-cascade.js"></script>');
    expect(shared).toBeGreaterThan(-1);
    expect(cascade).toBeGreaterThan(shared);
  });

  test("the fee page loads the shared picker before its filters", () => {
    const src = read("views/fees/list.ejs");
    const shared = src.indexOf('<script src="/js/student-typeahead.js"></script>');
    const fees = src.indexOf('<script src="/js/fees-list.js"></script>');
    expect(shared).toBeGreaterThan(-1);
    expect(fees).toBeGreaterThan(shared);
  });

  test("the shared Student partial renders a search box per panel and keeps the select as the submit control", () => {
    const src = read("views/reports/partials/filter-cascade.ejs");
    expect(src).toContain('id="<%= idp %>-student-search"');
    expect(src).toContain('name="<%= namep %>StudentId" id="<%= idp %>-student"');
    // narrowing attributes must survive, or the cascade loses Grade/Section
    expect(src).toContain('data-grade="<%= s.grade || \'none\' %>"');
    expect(src).toContain('data-section="<%= s.section || \'none\' %>"');
    expect(src).toContain('data-class="<%= s.classLevelId || \'\' %>"');
    // and the search fields the picker matches on
    expect(src).toContain('data-name="<%= s.name %>"');
    expect(src).toContain('data-roll="<%= s.rollNumber %>"');
  });

  test("the picker styles ship in the shared stylesheet, not per page", () => {
    const css = read("public/css/style.css");
    expect(css).toContain(".student-typeahead-results");
    expect(css).toContain(".student-typeahead-item");
    expect(read("views/fees/list.ejs")).not.toContain(".student-search-item");
  });
});
