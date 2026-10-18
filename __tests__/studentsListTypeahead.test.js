/**
 * Tests for the searchable Student picker on the All-Students page.
 *
 * Proves the page reuses the ONE shared typeahead component
 * (public/js/student-typeahead.js) and that the students-page wiring
 * (public/js/students-typeahead.js):
 *   • narrows the dropdown as you type (name OR roll number),
 *   • scopes it LIVE by the current Grade / Section / Class / Status selects, so
 *     a pupil outside the chosen cascade can never be offered or committed,
 *   • commits a pick into the hidden `name` control (the value GET /students
 *     already filters on) and submits the filter form, while typing-without-
 *     picking clears that value so a half-typed name is never submitted,
 *   • drops a committed pick when a filter above it changes.
 *
 * Both real files load into one Node vm with a minimal DOM stub, in the order
 * the page loads them. Page-wiring assertions then read the real view + route.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const PUBLIC_JS = path.join(ROOT, "public", "js");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ── minimal DOM stub (same shape as studentTypeahead.test.js) ────────────────
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
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    setAttribute(name, v) { this.attrs[name] = String(v); },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child; },
    get firstChild() { return this.children.length ? this.children[0] : null; },
    contains(node) { return this.children.some((c) => c === node || (c.contains && c.contains(node))); },
    querySelectorAll(sel) {
      if (sel.charAt(0) === ".") { const cls = sel.slice(1); return this.children.filter((c) => (c.className || "").split(" ").indexOf(cls) !== -1); }
      return this.children.filter((c) => c.tagName === sel);
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    fire(ev, arg) { (this._listeners[ev] || []).forEach((fn) => fn(arg || {})); },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return ""; },
    set(v) { if (v !== "") throw new Error("stub only supports clearing via innerHTML = ''"); el.children = []; el.value = ""; },
  });
  return el;
}

const rowTitles = (box) =>
  box.children
    .filter((c) => (c.className || "").indexOf("student-typeahead-item") === 0)
    .map((c) => c.children[0] && c.children[0].textContent);

// The roster the route embeds (see studentPool in routes/views/students.views.js).
const ROSTER = [
  { id: "ali",   name: "Ali Khan",   rollNumber: "7",  classId: "c9b",  grade: "9",  section: "Boys",  className: "9-Boys",  status: "active",   isGraduated: false, isWithdrawn: false, isSuspended: false },
  { id: "sara",  name: "Sara Malik", rollNumber: "12", classId: "c9g",  grade: "9",  section: "Girls", className: "9-Girls", status: "active",   isGraduated: false, isWithdrawn: false, isSuspended: false },
  { id: "bilal", name: "Bilal Ahmed",rollNumber: "3",  classId: "c10b", grade: "10", section: "Boys",  className: "10-Boys", status: "active",   isGraduated: false, isWithdrawn: false, isSuspended: false },
  { id: "hina",  name: "Hina Raza",  rollNumber: "5",  classId: "c9b2", grade: "9",  section: "Boys",  className: "9-Boys-B",status: "inactive", isGraduated: false, isWithdrawn: false, isSuspended: false },
];

function harness(initialName) {
  const els = {
    "st-student-search": makeEl("input"),
    "st-student-name": makeEl("input"),
    "st-student-results": makeEl("div"),
    "st-filter-grade": makeEl("select"),
    "st-filter-section": makeEl("select"),
    "st-filter-class": makeEl("select"),
    "st-filter-status": makeEl("select"),
    "students-typeahead-pool": makeEl("script"),
  };
  els["students-typeahead-pool"].textContent = JSON.stringify(ROSTER);
  els["st-student-name"].value = initialName || "";
  const submits = { n: 0 };
  const form = makeEl("form");
  form.submit = () => { submits.n += 1; };
  els["st-filter-form"] = form;

  els["st-student-search"].value = initialName || "";

  const byId = els;
  const sandbox = {
    document: {
      getElementById: (id) => (Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null),
      createElement: (t) => makeEl(t),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    window: {},
    String, Array, Object, JSON, Number, RegExp, Math,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ["student-typeahead.js", "students-typeahead.js"].forEach((m) => {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_JS, m), "utf8"), sandbox, { filename: m });
  });

  return { els, submits, search: els["st-student-search"], hidden: els["st-student-name"], results: els["st-student-results"] };
}

function type(h, q) { h.search.value = q; h.search.fire("input"); }

describe("All-Students searchable picker", () => {
  test("typing a partial name narrows the dropdown to matching pupils", () => {
    const h = harness();
    type(h, "sara");
    expect(rowTitles(h.results)).toEqual(["Sara Malik"]);
    expect(h.results.style.display).toBe("block");
  });

  test("roll-number search works, same as the fee picker", () => {
    const h = harness();
    type(h, "12");
    expect(rowTitles(h.results)).toEqual(["Sara Malik"]);
  });

  test("the dropdown respects the current Grade filter", () => {
    const h = harness();
    h.els["st-filter-grade"].value = "9";
    type(h, "bilal"); // Bilal is grade 10 → out of scope
    expect(rowTitles(h.results)).toEqual([]);
    type(h, "khan");
    expect(rowTitles(h.results)).toEqual(["Ali Khan"]);
  });

  test("the dropdown respects the current Section filter", () => {
    const h = harness();
    h.els["st-filter-grade"].value = "9";
    h.els["st-filter-section"].value = "Girls";
    type(h, "ali kh"); // Ali is grade-9 Boys
    expect(rowTitles(h.results)).toEqual([]);
    type(h, "sara");
    expect(rowTitles(h.results)).toEqual(["Sara Malik"]);
  });

  test("the dropdown respects the Status filter (inactive pupil only under Inactive)", () => {
    const h = harness();
    // No status chosen → the whole roster is offered, inactive pupil included.
    type(h, "hina");
    expect(rowTitles(h.results)).toEqual(["Hina Raza"]);
    h.els["st-filter-status"].value = "inactive";
    type(h, "hina");
    expect(rowTitles(h.results)).toEqual(["Hina Raza"]);
    type(h, "sara");
    expect(rowTitles(h.results)).toEqual([]); // Sara is active, excluded under Inactive
    h.els["st-filter-status"].value = "enrolled";
    type(h, "hina");
    expect(rowTitles(h.results)).toEqual([]); // inactive, excluded under Enrolled
  });

  test("Grade + Status combine: only in-scope, matching-status pupils are offered", () => {
    const h = harness();
    h.els["st-filter-grade"].value = "9";
    h.els["st-filter-status"].value = "enrolled";
    type(h, "hina"); expect(rowTitles(h.results)).toEqual([]);   // inactive
    type(h, "bilal"); expect(rowTitles(h.results)).toEqual([]);  // grade 10
    type(h, "ali k"); expect(rowTitles(h.results)).toEqual(["Ali Khan"]);
  });

  test("committing a row writes the hidden name and submits the filter form", () => {
    const h = harness();
    type(h, "sara");
    h.results.children[0].fire("click");
    expect(h.hidden.value).toBe("Sara Malik");
    expect(h.submits.n).toBe(1);
  });

  test("typing without picking clears the hidden value (no half-typed name submitted)", () => {
    const h = harness();
    type(h, "sara");
    h.results.children[0].fire("click");
    expect(h.hidden.value).toBe("Sara Malik");
    h.submits.n = 0;
    type(h, "sar"); // editing the committed name invalidates the pick
    expect(h.hidden.value).toBe("");
    expect(h.submits.n).toBe(0); // editing alone must not submit
  });

  test("changing a filter above the picker drops a committed pick", () => {
    const h = harness();
    type(h, "sara");
    h.results.children[0].fire("click");
    expect(h.hidden.value).toBe("Sara Malik");
    h.els["st-filter-grade"].value = "10";
    h.els["st-filter-grade"].fire("change");
    expect(h.hidden.value).toBe(""); // Sara (grade 9) no longer valid
  });

  test("a URL-carried name stays the committed pick, so blur does not blank it", () => {
    const h = harness("Ali Khan");
    expect(h.hidden.value).toBe("Ali Khan");
    h.search.fire("blur");
    expect(h.search.value).toBe("Ali Khan"); // box restores the pick, not blanked
    expect(h.hidden.value).toBe("Ali Khan"); // still the value that filters
  });

  test("a hostile stored name is rendered as text, never parsed", () => {
    const sandbox = { window: {}, document: { createElement: (t) => makeEl(t), addEventListener: () => {} }, String, Array, Object };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_JS, "student-typeahead.js"), "utf8"), sandbox, { filename: "student-typeahead.js" });
    const input = makeEl("input"), results = makeEl("div");
    sandbox.window.initStudentTypeahead({
      input, results,
      items: () => [{ id: "x", title: '<img src=x onerror="alert(1)">', keywords: "<img src=x onerror=alert(1)>" }],
    });
    input.value = "img"; input.fire("input");
    const row = results.children[0];
    expect(row.children[0].tagName).toBe("strong");
    expect(row.children[0].textContent).toBe('<img src=x onerror="alert(1)">');
    expect(row.children[0].innerHTML).toBe("");
  });
});

describe("page wiring", () => {
  test("the students page loads the shared picker, then the cascade, then its wiring", () => {
    const src = read("views/students/list.ejs");
    const shared = src.indexOf('<script src="/js/student-typeahead.js"></script>');
    const cascade = src.indexOf('<script src="/js/students-filter-cascade.js"></script>');
    const wiring = src.indexOf('<script src="/js/students-typeahead.js"></script>');
    expect(shared).toBeGreaterThan(-1);
    expect(cascade).toBeGreaterThan(shared);
    expect(wiring).toBeGreaterThan(cascade);
  });

  test("the picker markup keeps `name` as the submit control and searches name or roll", () => {
    const src = read("views/students/list.ejs");
    expect(src).toContain('id="st-student-search"');
    expect(src).toContain('name="name" id="st-student-name"');
    expect(src).toContain('id="st-student-results"');
    expect(src).toContain('id="st-filter-form"');
    expect(src).toContain("Search by name or roll number");
  });

  test("the cascade selects the picker scopes by all carry stable ids", () => {
    const src = read("views/students/list.ejs");
    ["st-filter-grade", "st-filter-section", "st-filter-class", "st-filter-status"].forEach((id) => {
      expect(src).toContain(`id="${id}"`);
    });
  });

  test("the roster pool is embedded as a non-executed JSON island with '<' escaped", () => {
    const src = read("views/students/list.ejs");
    expect(src).toContain('id="students-typeahead-pool"');
    expect(src).toMatch(/JSON\.stringify\([^)]*studentPool[^)]*\)\.replace\(\/</g);
  });

  test("the route supplies the pool with the fields the picker filters on", () => {
    const src = read("routes/views/students.views.js");
    expect(src).toContain("const studentPool = rosterForPicker.map");
    ["grade", "section", "classId", "isGraduated", "isWithdrawn", "isSuspended"].forEach((k) => {
      expect(src).toContain(`${k}:`);
    });
    // error branch still renders with an empty pool (view must not crash)
    expect(src).toContain("studentPool: []");
  });
});
