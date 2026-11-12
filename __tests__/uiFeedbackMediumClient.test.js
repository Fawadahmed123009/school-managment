/**
 * Batch 2 (Medium-severity) UI-feedback fixes — client half (vm DOM-stub
 * pattern, same as formFeedbackClient.test.js; no jsdom in the repo).
 *
 * Loads the REAL page scripts on top of the REAL foundation modules and pins:
 *   M1  every remaining alert() validation gate is now a toast and/or an
 *       inline field error that clears when the user fixes the field —
 *       nothing depends on window.alert (a silent no-op in the PWA).
 *   M2  the programmatic form.submit() flows (student + staff attendance)
 *       lock the Save button themselves (submit() fires no submit event, so
 *       the global double-submit guard never sees them) and restore on
 *       bfcache pageshow.
 *   M3  report-session-bulk's class picker distinguishes a FAILED load from
 *       an empty session (retry hint + toast, never "No grades in this
 *       session" on a network/API error).
 *   M5  test-manage's phase island parse is guarded — a malformed attribute
 *       leaves the list empty instead of killing every handler.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ── DOM stub (extended with form controls + a small selector engine) ────────

function matchSimple(el, sel) {
  let rest = sel;
  const tagM = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagM) {
    if (el.tagName !== tagM[0].toUpperCase()) return false;
    rest = rest.slice(tagM[0].length);
  }
  while (rest.length) {
    if (rest[0] === ".") {
      const m = rest.match(/^\.([\w-]+)/);
      if (!m || !el._classes.has(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "#") {
      const m = rest.match(/^#([\w-]+)/);
      if (!m || el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "[") {
      const m = rest.match(/^\[([\w-]+)(?:="([^"]*)")?\]/);
      if (!m) return false;
      const av = el.attrs[m[1]] !== undefined ? el.attrs[m[1]] : (m[1] === "value" ? el.value : undefined);
      if (av === undefined || av === null) return false;
      if (m[2] !== undefined && String(av) !== m[2]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith(":checked")) {
      if (!el.checked) return false;
      rest = rest.slice(":checked".length);
    } else {
      return false;
    }
  }
  return true;
}

function matchesSelector(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let idx = parts.length - 2;
  let node = el.parentNode;
  while (idx >= 0) {
    let found = false;
    while (node) {
      if (matchSimple(node, parts[idx])) { found = true; node = node.parentNode; break; }
      node = node.parentNode;
    }
    if (!found) return false;
    idx--;
  }
  return true;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    children: [],
    parentNode: null,
    attrs: {},
    dataset: {},
    style: {},
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    listeners: {},
    _classes: new Set(),
    _submitCount: 0,
  };
  el.classList = {
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    contains: (c) => el._classes.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !el._classes.has(c) : !!force;
      if (on) el._classes.add(c); else el._classes.delete(c);
      return on;
    },
  };
  Object.defineProperty(el, "className", {
    get: () => [...el._classes].join(" "),
    set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  Object.defineProperty(el, "innerHTML", {
    get: () => "",
    set: () => { el.children.slice().forEach((c) => el.removeChild(c)); },
  });
  if (el.tagName === "SELECT") {
    el.selectedIndex = -1;
    Object.defineProperty(el, "options", { get: () => el.children.filter((c) => c.tagName === "OPTION") });
    Object.defineProperty(el, "value", {
      get: () => { const o = el.options[el.selectedIndex]; return o ? o.value : ""; },
      set: (v) => { el.selectedIndex = el.options.findIndex((o) => String(o.value) === String(v)); },
    });
  }
  el.setAttribute = (k, v) => {
    el.attrs[k] = String(v);
    if (k === "id") el.id = String(v);
    // Real browsers keep dataset in sync with data-* attributes.
    if (k.indexOf("data-") === 0) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
  };
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.appendChild = (c) => { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = el; el.children.push(c); return c; };
  el.removeChild = (c) => { const i = el.children.indexOf(c); if (i !== -1) el.children.splice(i, 1); c.parentNode = null; return c; };
  el.insertBefore = (n, ref) => {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = el;
    const i = ref ? el.children.indexOf(ref) : -1;
    if (i === -1) el.children.push(n); else el.children.splice(i, 0, n);
    return n;
  };
  Object.defineProperty(el, "nextSibling", {
    get: () => {
      if (!el.parentNode) return null;
      const i = el.parentNode.children.indexOf(el);
      return el.parentNode.children[i + 1] || null;
    },
  });
  el.matches = (sel) => matchesSelector(el, sel);
  el.closest = (sel) => { let n = el; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; };
  const walk = (node, out) => { node.children.forEach((c) => { out.push(c); walk(c, out); }); return out; };
  el.querySelectorAll = (sel) => walk(el, []).filter((n) => matchesSelector(n, sel));
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  el.contains = (n) => n === el || walk(el, []).includes(n);
  el.addEventListener = (ev, cb) => { (el.listeners[ev] = el.listeners[ev] || []).push(cb); };
  // A disabled button fires no click in a real browser — mirror that so the
  // double-submit tests measure the actual lock, not the stub's generosity.
  el.dispatch = (ev, arg) => {
    if (ev === "click" && el.disabled) return;
    // Listeners run with this = the element, exactly like the real DOM.
    (el.listeners[ev] || []).slice().forEach((cb) => cb.call(el, arg || {}));
  };
  el.focus = () => {};
  el.submit = () => { el._submitCount++; };
  return el;
}

function makeDocument() {
  const body = makeEl("body");
  const doc = {
    body,
    activeElement: null,
    _listeners: {},
    createElement: (t) => makeEl(t),
    getElementById: (id) => body.querySelectorAll("#" + id)[0] || null,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: (ev, cb) => { (doc._listeners[ev] = doc._listeners[ev] || []).push(cb); },
    removeEventListener: () => {},
  };
  return doc;
}

const FOUNDATION = ["toast.js", "confirm-dialog.js", "form-feedback.js"];

/** Load foundation + page scripts into a fresh sandbox (foot.ejs order). */
function loadPage(files, { fetchImpl, pre } = {}) {
  const doc = makeDocument();
  const winListeners = {};
  const window = {
    CSRF_TOKEN: "csrf-test",
    location: { href: "" },
    addEventListener: (ev, cb) => { (winListeners[ev] = winListeners[ev] || []).push(cb); },
  };
  const sandbox = {
    window,
    document: doc,
    fetch: fetchImpl || (async () => ({ status: 200, redirected: false, text: async () => '{"status":"success","data":{}}' })),
    FormData: class FormData {},
    setTimeout, clearTimeout, Date, console,
  };
  vm.createContext(sandbox);
  FOUNDATION.forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8"), sandbox, { filename: f });
  });
  // In a browser window IS the global — expose bare identifiers.
  sandbox.Toast = sandbox.window.Toast;
  sandbox.ConfirmDialog = sandbox.window.ConfirmDialog;
  sandbox.FormFeedback = sandbox.window.FormFeedback;
  if (pre) pre(sandbox, doc);
  files.forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8"), sandbox, { filename: f });
  });
  return { sandbox, window, doc, winListeners };
}

const toastTexts = (doc) => {
  const host = doc.getElementById("toast-stack");
  if (!host) return [];
  return host.children.map((t) => {
    const b = t.querySelector(".toast-body");
    const m = b && b.querySelector(".toast-msg");
    return m ? m.textContent : "";
  });
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const jsonResponse = (status, payload) => async () => ({ status, redirected: false, text: async () => JSON.stringify(payload) });
const submitEvt = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

// Small builders shared across suites.
const byId = (doc, id) => doc.getElementById(id);
function addOpt(sel, value, label, dataset) {
  const o = makeEl("option");
  o.value = value;
  o.textContent = label || value;
  if (dataset) o.dataset = dataset;
  sel.appendChild(o);
  if (sel.selectedIndex === -1) sel.selectedIndex = 0;
  return o;
}
function mount(doc, el, parent) { (parent || doc.body).appendChild(el); return el; }
function elWithId(doc, tag, id, parent) { const el = makeEl(tag); el.id = id; el.attrs.id = id; return mount(doc, el, parent); }

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// ── M1 + M2: student attendance ─────────────────────────────────────────────

function attendanceDom(doc) {
  const form = elWithId(doc, "form", "attendance-form");
  elWithId(doc, "input", "records-input", form);
  const saveBtn = elWithId(doc, "button", "save-attendance-btn", form);
  saveBtn.textContent = "Save attendance";
  elWithId(doc, "span", "marked-count", form);
  const table = elWithId(doc, "table", "roster-table");
  const tbody = elWithId(doc, "tbody", "roster-body", table);
  const rows = ["s1", "s2"].map((sid) => {
    const tr = makeEl("tr");
    tr.dataset.student = sid;
    tr.dataset.name = "Pupil " + sid;
    tr.dataset.roll = sid;
    ["present", "absent"].forEach((status) => {
      const b = makeEl("button");
      b.className = "attend-btn";
      b.setAttribute("data-status", status);
      tr.appendChild(b);
    });
    tbody.appendChild(tr);
    return tr;
  });
  return { form, saveBtn, rows };
}

describe("M1/M2 — attendance-mark.js", () => {
  test("empty roster save → visible toast, no submit, button stays live", () => {
    const h = loadPage(["attendance-mark.js"], { pre: (sb, d) => attendanceDom(d) });
    const btn = byId(h.doc, "save-attendance-btn");
    btn.dispatch("click");
    expect(toastTexts(h.doc).join(" ")).toMatch(/Mark at least one student/i);
    expect(byId(h.doc, "attendance-form")._submitCount).toBe(0);
    expect(btn.disabled).toBe(false);
  });

  test("marked save serializes records, submits once, and locks the button", () => {
    const h = loadPage(["attendance-mark.js"], { pre: (sb, d) => attendanceDom(d) });
    const row = h.doc.querySelectorAll("#roster-body tr")[0];
    row.querySelector('.attend-btn[data-status="present"]').dispatch("click");
    const btn = byId(h.doc, "save-attendance-btn");
    btn.dispatch("click");
    expect(JSON.parse(byId(h.doc, "records-input").value)).toEqual([{ student: "s1", status: "present" }]);
    expect(byId(h.doc, "attendance-form")._submitCount).toBe(1);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Saving…");
    btn.dispatch("click"); // disabled — a real browser fires nothing
    expect(byId(h.doc, "attendance-form")._submitCount).toBe(1);
  });

  test("bfcache pageshow restores the locked Save button", () => {
    const h = loadPage(["attendance-mark.js"], { pre: (sb, d) => attendanceDom(d) });
    h.doc.querySelectorAll("#roster-body tr")[0].querySelector('.attend-btn[data-status="present"]').dispatch("click");
    const btn = byId(h.doc, "save-attendance-btn");
    btn.dispatch("click");
    (h.winListeners.pageshow || []).forEach((cb) => cb({ persisted: true }));
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Save attendance");
  });
});

// ── M1 + M2: staff attendance ───────────────────────────────────────────────

function staffAttendanceDom(doc) {
  const form = elWithId(doc, "form", "ta-form");
  elWithId(doc, "input", "records-input", form);
  const saveBtn = elWithId(doc, "button", "save-attendance-btn", form);
  saveBtn.textContent = "Save times";
  const island = elWithId(doc, "script", "ta-settings");
  island.textContent = JSON.stringify({ lateDetectionEnabled: false, startTime: "08:00", graceMinutes: 5 });
  const table = elWithId(doc, "table", "ta-roster");
  const tbody = mount(doc, makeEl("tbody"), table);
  const tr = makeEl("tr");
  tr.dataset.teacher = "t1";
  tr.dataset.name = "Miss Ayesha";
  tr.dataset.expected = "08:00";
  const arr = makeEl("input"); arr.className = "ta-arrival"; arr.setAttribute("type", "time");
  const dep = makeEl("input"); dep.className = "ta-departure"; dep.setAttribute("type", "time");
  const hours = makeEl("td"); hours.className = "ta-hours";
  const late = makeEl("td"); late.className = "ta-late";
  [arr, dep, hours, late].forEach((c) => tr.appendChild(c));
  tbody.appendChild(tr);
  return { form, saveBtn, arr, dep };
}

describe("M1/M2 — staff-attendance-mark.js", () => {
  test("no times entered → toast, no submit", () => {
    const h = loadPage(["staff-attendance-mark.js"], { pre: (sb, d) => staffAttendanceDom(d) });
    byId(h.doc, "save-attendance-btn").dispatch("click");
    expect(toastTexts(h.doc).join(" ")).toMatch(/Enter or correct at least one time/i);
    expect(byId(h.doc, "ta-form")._submitCount).toBe(0);
  });

  test("departure before arrival → inline error on the input + naming toast", () => {
    const h = loadPage(["staff-attendance-mark.js"], { pre: (sb, d) => staffAttendanceDom(d) });
    const { arr, dep } = staffAttendanceDomRefs(h.doc);
    arr.value = "09:00";
    dep.value = "08:00";
    byId(h.doc, "save-attendance-btn").dispatch("click");
    const errEl = dep.parentNode.querySelector(".field-error");
    expect(errEl && errEl.textContent).toMatch(/Departure must be after arrival/i);
    expect(dep._classes.has("input-invalid")).toBe(true);
    expect(toastTexts(h.doc).join(" ")).toMatch(/Miss Ayesha/);
    expect(byId(h.doc, "ta-form")._submitCount).toBe(0);
  });

  test("repeated invalid saves reuse ONE inline error, never stack duplicates", () => {
    const h = loadPage(["staff-attendance-mark.js"], { pre: (sb, d) => staffAttendanceDom(d) });
    const { arr, dep } = staffAttendanceDomRefs(h.doc);
    arr.value = "09:00";
    dep.value = "08:00";
    byId(h.doc, "save-attendance-btn").dispatch("click");
    byId(h.doc, "save-attendance-btn").dispatch("click");
    expect(dep.parentNode.querySelectorAll(".field-error").length).toBe(1);
  });

  test("fixing the time clears the inline error; save then locks + submits", () => {
    const h = loadPage(["staff-attendance-mark.js"], { pre: (sb, d) => staffAttendanceDom(d) });
    const { arr, dep } = staffAttendanceDomRefs(h.doc);
    arr.value = "09:00";
    dep.value = "08:00";
    byId(h.doc, "save-attendance-btn").dispatch("click");
    dep.value = "10:00";
    dep.dispatch("input");
    expect(dep.parentNode.querySelector(".field-error")).toBe(null);
    expect(dep._classes.has("input-invalid")).toBe(false);
    const btn = byId(h.doc, "save-attendance-btn");
    btn.dispatch("click");
    expect(byId(h.doc, "ta-form")._submitCount).toBe(1);
    expect(btn.disabled).toBe(true);
    (h.winListeners.pageshow || []).forEach((cb) => cb({ persisted: true }));
    expect(btn.disabled).toBe(false);
  });
});
function staffAttendanceDomRefs(doc) {
  const row = doc.querySelectorAll("#ta-roster tbody tr")[0];
  return { arr: row.querySelector(".ta-arrival"), dep: row.querySelector(".ta-departure") };
}

// ── M1: promotion picker ────────────────────────────────────────────────────

function promotionDom(doc) {
  const form = elWithId(doc, "form", "promotion-form");
  elWithId(doc, "input", "promotions-field", form);
  const previewBtn = elWithId(doc, "button", "preview-btn", form);
  previewBtn.textContent = "Preview changes";
  const bulkTarget = elWithId(doc, "select", "bulk-target");
  addOpt(bulkTarget, "", "Choose target…");
  addOpt(bulkTarget, "c2", "Grade 6-A");
  addOpt(bulkTarget, "graduate", "Graduate");
  elWithId(doc, "button", "bulk-apply-btn");
  elWithId(doc, "span", "change-count");
  const cbs = ["st1", "st2"].map((sid) => {
    const cb = makeEl("input");
    cb.className = "student-cb";
    cb.value = sid;
    mount(doc, cb);
    const sel = makeEl("select");
    sel.className = "target-select";
    sel.dataset.studentId = sid;
    addOpt(sel, "", "—");
    addOpt(sel, "c2", "Grade 6-A");
    addOpt(sel, "graduate", "Graduate");
    mount(doc, sel);
    return { cb, sel };
  });
  return { form, previewBtn, bulkTarget, cbs };
}

describe("M1 — promotion.js", () => {
  test("bulk apply without a target → inline on the select + toast", () => {
    const h = loadPage(["promotion.js"], { pre: (sb, d) => promotionDom(d) });
    byId(h.doc, "bulk-apply-btn").dispatch("click");
    const target = byId(h.doc, "bulk-target");
    const errEl = target.parentNode.querySelector(".field-error");
    expect(errEl && errEl.textContent).toMatch(/target class or "Graduate"/i);
    expect(toastTexts(h.doc).join(" ")).toMatch(/choose a target class/i);
  });

  test("choosing a target clears the inline error", () => {
    const h = loadPage(["promotion.js"], { pre: (sb, d) => promotionDom(d) });
    byId(h.doc, "bulk-apply-btn").dispatch("click");
    const target = byId(h.doc, "bulk-target");
    target.value = "c2";
    target.dispatch("change");
    expect(target.parentNode.querySelector(".field-error")).toBe(null);
  });

  test("bulk apply with a target but no ticks → toast, nothing applied", () => {
    const h = loadPage(["promotion.js"], { pre: (sb, d) => promotionDom(d) });
    const refs = promotionDomRefs(h.doc);
    refs.bulkTarget.value = "c2";
    byId(h.doc, "bulk-apply-btn").dispatch("click");
    expect(toastTexts(h.doc).join(" ")).toMatch(/No students are selected/i);
    expect(refs.cbs[0].sel.value).toBe("");
  });

  test("submit with no targets → prevented + toast, preview button stays live", () => {
    const h = loadPage(["promotion.js"], { pre: (sb, d) => promotionDom(d) });
    const evt = submitEvt();
    byId(h.doc, "promotion-form").dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(toastTexts(h.doc).join(" ")).toMatch(/assign a target class/i);
    expect(byId(h.doc, "preview-btn").disabled).toBe(false);
  });

  test("submit with targets serializes + locks the preview button", () => {
    const h = loadPage(["promotion.js"], { pre: (sb, d) => promotionDom(d) });
    const refs = promotionDomRefs(h.doc);
    refs.cbs[0].sel.value = "c2";
    const evt = submitEvt();
    byId(h.doc, "promotion-form").dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(JSON.parse(byId(h.doc, "promotions-field").value)).toEqual([{ studentId: "st1", action: "c2" }]);
    expect(refs.previewBtn.disabled).toBe(true);
    expect(refs.previewBtn.textContent).toBe("Loading preview…");
  });
});
function promotionDomRefs(doc) {
  const cbs = doc.querySelectorAll(".student-cb").map((cb, i) => ({
    cb,
    sel: doc.querySelectorAll(".target-select")[i],
  }));
  return { bulkTarget: byId(doc, "bulk-target"), previewBtn: byId(doc, "preview-btn"), cbs };
}

// ── M1: fee entry student picker ────────────────────────────────────────────

function feesDom(doc, { withForm = true } = {}) {
  const feeHead = elWithId(doc, "select", "feeHead");
  addOpt(feeHead, "", "—");
  elWithId(doc, "input", "amount");
  const island = elWithId(doc, "script", "fees-students");
  island.textContent = JSON.stringify([{ id: "st1", name: "Pupil One", rollNumber: 1, classId: "c1", className: "Grade 5", section: "A" }]);
  elWithId(doc, "input", "student-search");
  elWithId(doc, "input", "student");
  elWithId(doc, "div", "student-results");
  elWithId(doc, "select", "filter-class");
  elWithId(doc, "input", "filter-roll");
  if (withForm) {
    const form = makeEl("form");
    form.setAttribute("action", "/fees/create");
    mount(doc, form);
  }
}

describe("M1 — fees-list.js", () => {
  const withTypeahead = (sb) => {
    sb.window.__ta = null;
    sb.window.initStudentTypeahead = (cfg) => {
      sb.window.__ta = cfg;
      return { invalidate() {}, open() {} };
    };
  };

  test("submit without a picked student → prevented + inline + toast", () => {
    const h = loadPage(["fees-list.js"], { pre: (sb, d) => { feesDom(d); withTypeahead(sb); } });
    const evt = submitEvt();
    h.doc.querySelector('form[action="/fees/create"]').dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(true);
    const search = byId(h.doc, "student-search");
    const errEl = search.closest(".field") ? search.closest(".field").querySelector(".field-error") : search.parentNode.querySelector(".field-error");
    expect(errEl && errEl.textContent).toMatch(/select a student/i);
    expect(toastTexts(h.doc).join(" ")).toMatch(/select a student from the search results/i);
  });

  test("picking a student clears the error and lets the submit through", () => {
    const h = loadPage(["fees-list.js"], { pre: (sb, d) => { feesDom(d); withTypeahead(sb); } });
    const form = h.doc.querySelector('form[action="/fees/create"]');
    form.dispatch("submit", submitEvt());
    h.sandbox.window.__ta.onSelect({ id: "st1", title: "Pupil One" });
    expect(byId(h.doc, "student").value).toBe("st1");
    const evt = submitEvt();
    form.dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(false);
  });

  test("a page without the create form loads without throwing (null guard)", () => {
    expect(() => loadPage(["fees-list.js"], { pre: (sb, d) => { feesDom(d, { withForm: false }); withTypeahead(sb); } })).not.toThrow();
  });
});

// ── M1: assignment class sections ───────────────────────────────────────────

function assignmentDom(doc) {
  const subject = elWithId(doc, "select", "subject");
  addOpt(subject, "", "—");
  const field = makeEl("div");
  field.className = "field";
  mount(doc, field);
  elWithId(doc, "div", "classCheckboxes", field);
  elWithId(doc, "span", "selectionCount");
  elWithId(doc, "form", "assignmentForm");
  ["subjectClassMap", "subjectHasAppliesTo", "allClassesData", "sortedGradesData", "classesByGradeData"].forEach((id) => {
    const island = elWithId(doc, "script", id);
    island.textContent = "{}";
  });
}

describe("M1 — assignment-classes.js", () => {
  test("submit with no sections → prevented + inline on the group + toast", () => {
    const h = loadPage(["assignment-classes.js"], { pre: (sb, d) => assignmentDom(d) });
    const evt = submitEvt();
    byId(h.doc, "assignmentForm").dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(true);
    const container = byId(h.doc, "classCheckboxes");
    const errEl = container.closest(".field").querySelector(".field-error");
    expect(errEl && errEl.textContent).toMatch(/at least one class section/i);
    expect(toastTexts(h.doc).join(" ")).toMatch(/at least one class section/i);
  });

  test("a checked section lets the submit through", () => {
    const h = loadPage(["assignment-classes.js"], { pre: (sb, d) => assignmentDom(d) });
    const cb = makeEl("input");
    cb.className = "class-checkbox";
    cb.checked = true;
    byId(h.doc, "classCheckboxes").appendChild(cb);
    const evt = submitEvt();
    byId(h.doc, "assignmentForm").dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(false);
  });
});

// ── M1: bulk fee assignment ─────────────────────────────────────────────────

function bulkAssignDom(doc) {
  const targetType = elWithId(doc, "select", "targetType");
  addOpt(targetType, "class", "By class");
  addOpt(targetType, "student", "By student");
  elWithId(doc, "div", "class-field");
  const feeHead = elWithId(doc, "select", "feeHead");
  addOpt(feeHead, "", "—");
  addOpt(feeHead, "h1", "Tuition");
  elWithId(doc, "input", "amount");
  elWithId(doc, "input", "perStudentAmounts");
  elWithId(doc, "span", "preview-text");
  elWithId(doc, "div", "preview-body");
  const form = elWithId(doc, "form", "bulk-assign-form");
  const submitBtn = elWithId(doc, "button", "submit-btn", form);
  submitBtn.textContent = "Create fees";
  ["c1", "c2"].forEach((cid) => {
    const cb = makeEl("input");
    cb.className = "class-cb";
    cb.value = cid;
    mount(doc, cb);
  });
  return { feeHead, submitBtn };
}

describe("M1 — bulk-assign.js", () => {
  test("no class ticked → prevented + toast", () => {
    const h = loadPage(["bulk-assign.js"], { pre: (sb, d) => bulkAssignDom(d) });
    const evt = submitEvt();
    byId(h.doc, "bulk-assign-form").dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(toastTexts(h.doc).join(" ")).toMatch(/select at least one class/i);
  });

  test("class ticked but no fee head → prevented + inline on the select", () => {
    const h = loadPage(["bulk-assign.js"], { pre: (sb, d) => bulkAssignDom(d) });
    h.doc.querySelectorAll(".class-cb")[0].checked = true;
    const evt = submitEvt();
    byId(h.doc, "bulk-assign-form").dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(true);
    const feeHead = byId(h.doc, "feeHead");
    const errEl = feeHead.parentNode.querySelector(".field-error");
    expect(errEl && errEl.textContent).toMatch(/select a fee head/i);
  });

  test("choosing a head clears the inline error; valid submit locks the button", () => {
    const h = loadPage(["bulk-assign.js"], { pre: (sb, d) => bulkAssignDom(d) });
    h.doc.querySelectorAll(".class-cb")[0].checked = true;
    byId(h.doc, "bulk-assign-form").dispatch("submit", submitEvt());
    const feeHead = byId(h.doc, "feeHead");
    feeHead.value = "h1";
    feeHead.dispatch("change");
    expect(feeHead.parentNode.querySelector(".field-error")).toBe(null);
    const evt = submitEvt();
    byId(h.doc, "bulk-assign-form").dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(byId(h.doc, "submit-btn").disabled).toBe(true);
    expect(byId(h.doc, "submit-btn").textContent).toBe("Creating…");
  });
});

// ── M1 + M3: session-report bulk picker ─────────────────────────────────────

function sessionBulkDom(doc) {
  elWithId(doc, "input", "sr-scope");
  const session = elWithId(doc, "select", "sr-session");
  addOpt(session, "", "-- Select session --");
  addOpt(session, "sess1", "2026 Mid", { phases: "[]" });
  const period = elWithId(doc, "select", "sr-period");
  ["", "phase", "week", "weeks"].forEach((v) => addOpt(period, v, v || "Whole session"));
  elWithId(doc, "select", "phaseId_sr");
  elWithId(doc, "select", "weekId_sr");
  elWithId(doc, "select", "sr-student");
  const gradeGrade = elWithId(doc, "select", "sr-grade-grade");
  const form = elWithId(doc, "form", "pdfForm");
  const reportType = elWithId(doc, "select", "reportType", form);
  addOpt(reportType, "result-sheet", "Result sheet");
  addOpt(reportType, "session-report", "Session report");
  return { session, gradeGrade, reportType };
}

describe("M3 — report-session-bulk.js class-load failure is not an empty state", () => {
  test("API failure → retry placeholder + error toast, not 'No grades'", async () => {
    const h = loadPage(["report-session-bulk.js"], {
      pre: (sb, d) => sessionBulkDom(d),
      fetchImpl: jsonResponse(500, { status: "failed", message: "Server exploded" }),
    });
    const { session, gradeGrade } = sessionBulkRefs(h.doc);
    session.value = "sess1";
    session.dispatch("change");
    await flush();
    expect(gradeGrade.options[0].textContent).toMatch(/Could not load grades.*retry/i);
    expect(gradeGrade.options[0].textContent).not.toMatch(/No grades in this session/);
    expect(toastTexts(h.doc).join(" ")).toMatch(/Server exploded/);
    expect(toastTexts(h.doc).join(" ")).toMatch(/Re-select the session to retry/);
  });

  test("non-JSON reply (expired session) takes the same visible failure path", async () => {
    const h = loadPage(["report-session-bulk.js"], {
      pre: (sb, d) => sessionBulkDom(d),
      fetchImpl: async () => ({ status: 200, redirected: true, text: async () => "<html>login</html>" }),
    });
    const { session, gradeGrade } = sessionBulkRefs(h.doc);
    session.value = "sess1";
    session.dispatch("change");
    await flush();
    expect(gradeGrade.options[0].textContent).toMatch(/Could not load grades/i);
    expect(toastTexts(h.doc).join(" ")).toMatch(/session expired/i);
  });

  test("successful load fills grades and keeps the normal placeholder", async () => {
    const h = loadPage(["report-session-bulk.js"], {
      pre: (sb, d) => sessionBulkDom(d),
      fetchImpl: jsonResponse(200, { status: "success", data: { classes: [{ _id: "c1", gradeLevel: "5", name: "Grade 5-A" }] } }),
    });
    const { session, gradeGrade } = sessionBulkRefs(h.doc);
    session.value = "sess1";
    session.dispatch("change");
    await flush();
    expect(gradeGrade.options[0].textContent).toBe("-- Select grade --");
    expect(gradeGrade.options.some((o) => o.value === "5")).toBe(true);
    expect(toastTexts(h.doc)).toHaveLength(0);
  });

  test("genuinely empty session still says 'No grades in this session'", async () => {
    const h = loadPage(["report-session-bulk.js"], {
      pre: (sb, d) => sessionBulkDom(d),
      fetchImpl: jsonResponse(200, { status: "success", data: { classes: [] } }),
    });
    const { session, gradeGrade } = sessionBulkRefs(h.doc);
    session.value = "sess1";
    session.dispatch("change");
    await flush();
    expect(gradeGrade.options[0].textContent).toBe("No grades in this session");
  });
});
function sessionBulkRefs(doc) {
  return { session: byId(doc, "sr-session"), gradeGrade: byId(doc, "sr-grade-grade"), reportType: byId(doc, "reportType") };
}

describe("M1 — report-session-bulk.js submit guard", () => {
  test("session-report with no session → prevented + toast", () => {
    const h = loadPage(["report-session-bulk.js"], { pre: (sb, d) => sessionBulkDom(d) });
    const { reportType } = sessionBulkRefs(h.doc);
    reportType.value = "session-report";
    const evt = submitEvt();
    byId(h.doc, "pdfForm").dispatch("submit", evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(toastTexts(h.doc).join(" ")).toMatch(/Please select a session/i);
  });
});

// ── M5: test-manage phase island ────────────────────────────────────────────

function testManageDom(doc, phasesAttr) {
  const session = elWithId(doc, "select", "session");
  addOpt(session, "", "—");
  addOpt(session, "s1", "2026 Mid");
  session.options[1].setAttribute("data-phases", phasesAttr);
  elWithId(doc, "select", "phase");
  elWithId(doc, "select", "week");
  elWithId(doc, "div", "phase-field");
  elWithId(doc, "div", "week-field");
  elWithId(doc, "span", "week-hint");
  return session;
}

describe("M5 — test-manage.js survives a malformed phase island", () => {
  test("malformed data-phases does not throw or kill the handlers", () => {
    const h = loadPage(["test-manage.js"], { pre: (sb, d) => testManageDom(d, "{not-json") });
    const session = byId(h.doc, "session");
    session.value = "s1";
    expect(() => session.dispatch("change")).not.toThrow();
    // The week handler is still wired: picking no phase hides the week field.
    byId(h.doc, "phase").dispatch("change");
    expect(byId(h.doc, "week-field").style.display).toBe("none");
  });

  test("valid data-phases still populates the phase select", () => {
    const h = loadPage(["test-manage.js"], { pre: (sb, d) => testManageDom(d, JSON.stringify([{ _id: "p1", name: "Term 1" }])) });
    const session = byId(h.doc, "session");
    session.value = "s1";
    session.dispatch("change");
    const phase = byId(h.doc, "phase");
    expect(phase.options.some((o) => o.value === "p1" && o.textContent === "Term 1")).toBe(true);
  });
});