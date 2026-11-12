/**
 * Batch 3 — confirm-submit.js: the global delete gate now uses the themed
 * ConfirmDialog instead of window.confirm (a silent no-op in the installed
 * PWA — the same root cause as the original marks-entry bug, and deletes
 * are the highest-stakes gated actions in the system).
 *
 * Two layers of coverage, per the audit scope ("test on every delete form
 * it touches, not just a sample"):
 *   1. Behavioral contracts of the gate itself — confirm submits exactly
 *      once through a REAL submit event (page validation + double-submit
 *      lock still run), cancel/Esc/scrim never submit, no dialog stacking,
 *      bfcache re-arm, ancient-engine fallback, danger focus safety.
 *   2. An EXHAUSTIVE per-form sweep: every form[data-confirm] in views/ is
 *      extracted from the real templates (dynamic scan — a newly added
 *      delete form is automatically covered) and driven through the full
 *      confirm AND cancel cycle with its exact action + message.
 *
 * ConfirmDialog internals (queue, Esc, scrim, textContent-only) are pinned
 * by formFeedbackClient.test.js; this suite pins the WIRING.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ── DOM stub (selector engine incl. [attr="v" i] + comma lists) ─────────────

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
      const m = rest.match(/^\[([\w-]+)(?:="([^"]*)")?\s*(i)?\]/);
      if (!m) return false;
      const av = el.attrs[m[1]];
      if (av === undefined || av === null) return false;
      if (m[2] !== undefined) {
        const eq = m[3] ? String(av).toLowerCase() === m[2].toLowerCase() : String(av) === m[2];
        if (!eq) return false;
      }
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

// Split on whitespace combinators, but never inside [attr="v" i] brackets.
function splitCombinators(branch) {
  const parts = [];
  let cur = "", depth = 0, quote = null;
  for (const ch of branch.trim()) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function matchesSelector(el, sel) {
  return sel.split(",").some((branch) => {
    const parts = splitCombinators(branch);
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
  });
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
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); if (k === "id") el.id = String(v); };
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.appendChild = (c) => { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = el; el.children.push(c); return c; };
  el.removeChild = (c) => { const i = el.children.indexOf(c); if (i !== -1) el.children.splice(i, 1); c.parentNode = null; return c; };
  el.matches = (sel) => matchesSelector(el, sel);
  el.closest = (sel) => { let n = el; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; };
  const walk = (node, out) => { node.children.forEach((c) => { out.push(c); walk(c, out); }); return out; };
  el.querySelectorAll = (sel) => walk(el, []).filter((n) => matchesSelector(n, sel));
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  el.contains = (n) => n === el || walk(el, []).includes(n);
  el.addEventListener = (ev, cb) => { (el.listeners[ev] = el.listeners[ev] || []).push(cb); };
  el.focus = () => {};
  // A disabled button fires no click in a real browser; listeners run with
  // this = the element, exactly like the DOM.
  el.dispatch = (ev, arg) => {
    if (ev === "click" && el.disabled) return;
    (el.listeners[ev] || []).slice().forEach((cb) => cb.call(el, arg || {}));
  };
  // submit() fires NO event (the M2 footgun); requestSubmit() fires a real
  // one and only navigates when nothing prevented it.
  el.submit = () => { el._submitCount++; };
  el.requestSubmit = () => {
    const evt = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    el.dispatch("submit", evt);
    if (!evt.defaultPrevented) el._submitCount++;
  };
  return el;
}

function makeDocument() {
  const body = makeEl("body");
  const doc = {
    body,
    activeElement: null,
    _listeners: {},
    createElement: (t) => {
      const el = makeEl(t);
      el.focus = () => { doc.activeElement = el; };
      return el;
    },
    getElementById: (id) => body.querySelectorAll("#" + id)[0] || null,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: (ev, cb) => { (doc._listeners[ev] = doc._listeners[ev] || []).push(cb); },
    removeEventListener: (ev, cb) => { doc._listeners[ev] = (doc._listeners[ev] || []).filter((f) => f !== cb); },
    dispatch: (ev, arg) => { (doc._listeners[ev] || []).slice().forEach((cb) => cb.call(doc, arg || {})); },
  };
  return doc;
}

/** Load the REAL dialog + gate, build the DOM first, then DOMContentLoaded. */
function loadGate(pre) {
  const doc = makeDocument();
  const winListeners = {};
  const window = {
    // Poison: any window.confirm call fails the test loudly — the whole
    // point of B3 is that nothing depends on it anymore.
    confirm: () => { throw new Error("window.confirm must never be called"); },
    addEventListener: (ev, cb) => { (winListeners[ev] = winListeners[ev] || []).push(cb); },
  };
  const sandbox = {
    window,
    document: doc,
    setTimeout, clearTimeout, Date, console, Promise,
  };
  vm.createContext(sandbox);
  ["confirm-dialog.js", "confirm-submit.js"].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8"), sandbox, { filename: f });
  });
  sandbox.ConfirmDialog = sandbox.window.ConfirmDialog;
  if (pre) pre(doc);
  doc.dispatch("DOMContentLoaded");
  return { sandbox, window, doc, winListeners };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const submitEvt = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

function makeForm(doc, { action = "/things/1/delete", message = "Delete this thing?", method = "POST" } = {}) {
  const form = makeEl("form");
  form.setAttribute("method", method);
  form.setAttribute("action", action);
  if (message !== null) form.setAttribute("data-confirm", message);
  const btn = makeEl("button");
  btn.setAttribute("type", "submit");
  btn.textContent = "Delete";
  form.appendChild(btn);
  doc.body.appendChild(form);
  return { form, btn };
}

async function openDialog(h, form) {
  form.dispatch("submit", submitEvt());
  await flush();
  return h.doc.querySelector(".confirm-overlay");
}
async function settle(h, overlay, selector) {
  overlay.querySelector(selector).dispatch("click");
  jest.advanceTimersByTime(150); // ConfirmDialog exit animation, then resolve
  await flush();
}
const dialogMessage = (overlay) =>
  overlay.querySelector(".confirm-message").children.map((p) => p.textContent).join("\n");

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// ── Exhaustive inventory: EVERY data-confirm form in the real templates ─────

const VIEWS = path.join(__dirname, "..", "views");
function scanInventory() {
  const out = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!e.name.endsWith(".ejs")) return;
      const src = fs.readFileSync(p, "utf8");
      // Anchor on the data-confirm attribute, then widen to the enclosing
      // <form ...> tag — action values contain EJS `%>`, so a naive
      // <form[^>]*> scan would stop at the first interpolated ObjectId.
      const re = /data-confirm="([^"]*)"/g;
      let m;
      while ((m = re.exec(src))) {
        const start = src.lastIndexOf("<form", m.index);
        if (start === -1) continue;
        const end = src.indexOf(">", m.index + m[0].length);
        const tag = src.slice(start, end === -1 ? undefined : end + 1);
        out.push({
          file: path.relative(VIEWS, p),
          message: m[1],
          action: (tag.match(/action="([^"]*)"/) || [])[1] || "",
          method: ((tag.match(/method="([^"]*)"/) || [])[1] || "GET").toUpperCase(),
        });
      }
    });
  };
  walk(VIEWS);
  return out;
}
const INVENTORY = scanInventory();
const lastSegment = (action) => action.split("?")[0].split("/").filter(Boolean).pop() || "";
const expectedFor = (action) => {
  const last = lastSegment(action);
  return {
    danger: last === "delete" || last === "remove-student" || last === "finalize",
    label: last === "delete" ? "Delete" : last === "remove-student" ? "Remove" : last === "finalize" ? "Finalize" : "Confirm",
  };
};

describe("inventory sanity", () => {
  test("every gated form in views/ is found (18 today) and is a POST", () => {
    expect(INVENTORY.length).toBeGreaterThanOrEqual(18);
    INVENTORY.forEach((f) => expect(f.method).toBe("POST"));
  });
});

describe.each(INVENTORY.map((f, i) => [i, f]))("gate sweep — %s", (_i, entry) => {
  const label = `${entry.file} → ${lastSegment(entry.action)}`;

  test(`${label}: CONFIRM shows the exact message, themed button, submits once + locks`, async () => {
    const h = loadGate((doc) => makeForm(doc, entry));
    const form = h.doc.querySelector("form[data-confirm]");
    const btn = form.querySelector('button[type="submit"]');
    const overlay = await openDialog(h, form);
    expect(overlay).not.toBe(null);
    expect(dialogMessage(overlay)).toBe(entry.message);
    const exp = expectedFor(entry.action);
    const okBtn = overlay.querySelector(".confirm-ok");
    expect(okBtn.textContent).toBe(exp.label);
    expect(overlay.querySelector(".confirm-dialog").classList.contains("confirm-danger")).toBe(exp.danger);
    await settle(h, overlay, ".confirm-ok");
    expect(form._submitCount).toBe(1);
    expect(form.__locked).toBe(true);
    expect(btn.disabled).toBe(true);
    expect(h.doc.querySelector(".confirm-overlay")).toBe(null);
  });

  test(`${label}: CANCEL never submits, never locks, dialog closes`, async () => {
    const h = loadGate((doc) => makeForm(doc, entry));
    const form = h.doc.querySelector("form[data-confirm]");
    const btn = form.querySelector('button[type="submit"]');
    const overlay = await openDialog(h, form);
    await settle(h, overlay, ".confirm-cancel");
    expect(form._submitCount).toBe(0);
    expect(form.__locked).toBeFalsy();
    expect(btn.disabled).toBe(false);
    expect(h.doc.querySelector(".confirm-overlay")).toBe(null);
  });
});

// ── Behavioral contracts of the gate ────────────────────────────────────────

describe("confirm-submit gate — submit integrity", () => {
  test("a second submit while locked is blocked without reopening the dialog", async () => {
    const h = loadGate((doc) => makeForm(doc));
    const { form } = { form: h.doc.querySelector("form") };
    const overlay = await openDialog(h, form);
    await settle(h, overlay, ".confirm-ok");
    expect(form._submitCount).toBe(1);
    form.dispatch("submit", submitEvt()); // e.g. Enter key mid-navigation
    await flush();
    expect(h.doc.querySelector(".confirm-overlay")).toBe(null);
    expect(form._submitCount).toBe(1);
  });

  test("cancel then retry: the gate re-arms and a later confirm submits", async () => {
    const h = loadGate((doc) => makeForm(doc));
    const form = h.doc.querySelector("form");
    await settle(h, await openDialog(h, form), ".confirm-cancel");
    expect(form._submitCount).toBe(0);
    await settle(h, await openDialog(h, form), ".confirm-ok");
    expect(form._submitCount).toBe(1);
  });

  test("Escape cancels without submitting", async () => {
    const h = loadGate((doc) => makeForm(doc));
    const form = h.doc.querySelector("form");
    await openDialog(h, form);
    h.doc.dispatch("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
    jest.advanceTimersByTime(150);
    await flush();
    expect(form._submitCount).toBe(0);
    expect(form.__locked).toBeFalsy();
  });

  test("scrim press cancels; a drag ending on the scrim does not", async () => {
    const h = loadGate((doc) => makeForm(doc));
    const form = h.doc.querySelector("form");
    let overlay = await openDialog(h, form);
    // mouseup alone (selection drag released outside) — dialog stays
    overlay.dispatch("mouseup", { target: overlay });
    await flush();
    expect(h.doc.querySelector(".confirm-overlay")).not.toBe(null);
    // a press that STARTS on the scrim cancels
    overlay.dispatch("mousedown", { target: overlay });
    overlay.dispatch("mouseup", { target: overlay });
    jest.advanceTimersByTime(150);
    await flush();
    expect(form._submitCount).toBe(0);
    expect(h.doc.querySelector(".confirm-overlay")).toBe(null);
  });

  test("double click while the dialog is open queues nothing — one dialog, one submit", async () => {
    const h = loadGate((doc) => makeForm(doc));
    const form = h.doc.querySelector("form");
    form.dispatch("submit", submitEvt());
    form.dispatch("submit", submitEvt());
    await flush();
    expect(h.doc.querySelectorAll(".confirm-overlay").length).toBe(1);
    await settle(h, h.doc.querySelector(".confirm-overlay"), ".confirm-ok");
    expect(form._submitCount).toBe(1);
  });

  test("page validation listeners still run on the confirmed submit (requestSubmit, not submit)", async () => {
    let input;
    const h = loadGate((doc) => {
      const { form } = makeForm(doc);
      input = makeEl("input");
      form.appendChild(input);
      // A page-level guard, exactly like the create-form validators:
      form.addEventListener("submit", (e) => { if (!input.value) e.preventDefault(); });
    });
    const form = h.doc.querySelector("form");
    await settle(h, await openDialog(h, form), ".confirm-ok");
    expect(form._submitCount).toBe(0); // validation blocked the re-fired submit
    expect(form.__locked).toBeFalsy();
    input.value = "ok";
    await settle(h, await openDialog(h, form), ".confirm-ok"); // bypass was one-shot: dialog again
    expect(form._submitCount).toBe(1);
    expect(form.__locked).toBe(true);
  });

  test("bfcache pageshow unlocks AND re-arms the gate", async () => {
    const h = loadGate((doc) => makeForm(doc));
    const form = h.doc.querySelector("form");
    const btn = form.querySelector('button[type="submit"]');
    await settle(h, await openDialog(h, form), ".confirm-ok");
    expect(btn.disabled).toBe(true);
    (h.winListeners.pageshow || []).forEach((cb) => cb({ persisted: true }));
    expect(btn.disabled).toBe(false);
    expect(form.__locked).toBe(false);
    const overlay = await openDialog(h, form); // gate armed again, no stale bypass
    expect(overlay).not.toBe(null);
    await settle(h, overlay, ".confirm-ok");
    expect(form._submitCount).toBe(2);
  });

  test("ancient engine without requestSubmit: manual lock + submit() once", async () => {
    const h = loadGate((doc) => makeForm(doc));
    const form = h.doc.querySelector("form");
    const btn = form.querySelector('button[type="submit"]');
    form.requestSubmit = undefined;
    await settle(h, await openDialog(h, form), ".confirm-ok");
    expect(form._submitCount).toBe(1);
    expect(form.__locked).toBe(true);
    expect(btn.disabled).toBe(true);
  });
});

describe("confirm-submit gate — safety + scope", () => {
  test("danger dialog focuses Cancel; a plain confirm focuses Confirm", async () => {
    const h = loadGate((doc) => {
      makeForm(doc, { action: "/students/1/delete" });
      makeForm(doc, { action: "/sessions/1/weeks/2/clone/confirm", message: "Clone?" });
    });
    const [del, clone] = h.doc.querySelectorAll("form[data-confirm]");
    let overlay = await openDialog(h, del);
    expect(h.doc.activeElement).toBe(overlay.querySelector(".confirm-cancel"));
    await settle(h, overlay, ".confirm-cancel");
    overlay = await openDialog(h, clone);
    expect(h.doc.activeElement).toBe(overlay.querySelector(".confirm-ok"));
    expect(overlay.querySelector(".confirm-dialog").classList.contains("confirm-danger")).toBe(false);
    await settle(h, overlay, ".confirm-ok");
    expect(clone._submitCount).toBe(1);
  });

  test("a message containing HTML is shown as text, never parsed", async () => {
    const evil = 'Delete <img src=x onerror="alert(1)"> <b>bold</b>?';
    const h = loadGate((doc) => makeForm(doc, { message: evil }));
    const form = h.doc.querySelector("form");
    const overlay = await openDialog(h, form);
    expect(dialogMessage(overlay)).toBe(evil);
    expect(overlay.querySelectorAll("img").length).toBe(0);
    expect(overlay.querySelectorAll("b").length).toBe(0);
    await settle(h, overlay, ".confirm-cancel");
  });

  test("plain POST form without data-confirm locks immediately, no dialog", async () => {
    const h = loadGate((doc) => makeForm(doc, { message: null, action: "/things/create" }));
    const form = h.doc.querySelector("form");
    const btn = form.querySelector('button[type="submit"]');
    const evt = submitEvt();
    form.dispatch("submit", evt);
    await flush();
    expect(evt.defaultPrevented).toBe(false);
    expect(h.doc.querySelector(".confirm-overlay")).toBe(null);
    expect(form.__locked).toBe(true);
    expect(btn.disabled).toBe(true);
    const evt2 = submitEvt();
    form.dispatch("submit", evt2);
    expect(evt2.defaultPrevented).toBe(true);
  });

  test("GET form with data-confirm is gated too (no POST lock applies)", async () => {
    const h = loadGate((doc) => makeForm(doc, { method: "GET", action: "/search", message: "Run search?" }));
    const form = h.doc.querySelector("form");
    await settle(h, await openDialog(h, form), ".confirm-ok");
    expect(form._submitCount).toBe(1);
    expect(form.querySelector('button[type="submit"]').disabled).toBe(false);
  });
});