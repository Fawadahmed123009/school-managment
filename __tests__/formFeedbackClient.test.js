/**
 * Batch 1 foundation — client feedback contracts (vm DOM-stub pattern, same
 * as ocrMarksRosterScope.test.js / c3XssReview.test.js; no jsdom in the repo).
 *
 * Loads the REAL public/js modules and pins the guarantees every fixed form
 * now relies on:
 *   FormFeedback.fetchJson — never throws, never assumes JSON; ok only for a
 *     2xx success envelope; CSRF/Bearer auto-attach; FormData keeps multipart.
 *   FormFeedback.busy — restores on demand AND on bfcache pageshow.
 *   FormFeedback field errors / statusFor — inline, aria-wired, clearable.
 *   Toast — sticky errors, auto-dismiss + hover pause, dedup, hard stack cap
 *     (the cap loop must terminate under a burst), textContent-only rendering.
 *   ConfirmDialog — always resolves (the PWA confirm() no-op root cause),
 *     Esc/scrim/Cancel cancel, danger focuses Cancel, asks serialize.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ── Minimal DOM stub ─────────────────────────────────────────────────────────

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    children: [],
    parentNode: null,
    attrs: {},
    style: {},
    textContent: "",
    disabled: false,
    listeners: {},
    _classes: new Set(),
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
  el.matches = (sel) => {
    if (sel.startsWith(".")) return el._classes.has(sel.slice(1));
    if (sel.startsWith("#")) return el.id === sel.slice(1);
    return el.tagName === sel.toUpperCase();
  };
  el.closest = (sel) => { let n = el; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; };
  const walk = (node, out) => { node.children.forEach((c) => { out.push(c); walk(c, out); }); return out; };
  el.querySelectorAll = (sel) => walk(el, []).filter((n) => n.matches(sel));
  el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null;
  el.contains = (n) => n === el || walk(el, []).includes(n);
  el.addEventListener = (ev, cb) => { (el.listeners[ev] = el.listeners[ev] || []).push(cb); };
  el.dispatch = (ev, arg) => { (el.listeners[ev] || []).slice().forEach((cb) => cb(arg || {})); };
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
    dispatch: (ev, arg) => { (doc._listeners[ev] || []).slice().forEach((cb) => cb(arg || {})); },
  };
  return doc;
}

/** Load real client modules into a fresh sandbox with the stub DOM. */
function loadClient(files, { csrf, auth, fetchImpl } = {}) {
  const doc = makeDocument();
  const metaEl = auth ? makeEl("meta") : null;
  if (metaEl) metaEl.content = auth;
  doc.querySelector = (sel) => (sel === 'meta[name="auth-token"]' ? metaEl : doc.body.querySelector(sel));
  const winListeners = {};
  const window = {
    CSRF_TOKEN: csrf,
    addEventListener: (ev, cb) => { (winListeners[ev] = winListeners[ev] || []).push(cb); },
  };
  const sandbox = {
    window,
    document: doc,
    fetch: fetchImpl || (async () => ({ status: 200, redirected: false, text: async () => '{"status":"success"}' })),
    FormData: class FormData {},
    setTimeout, clearTimeout, Date, console,
  };
  vm.createContext(sandbox);
  files.forEach((f) => {
    const code = fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8");
    vm.runInContext(code, sandbox, { filename: f });
  });
  return { sandbox, window, doc, winListeners };
}

const jsonResponse = (status, payload, redirected = false) => async () => ({
  status, redirected, text: async () => JSON.stringify(payload),
});

// ── FormFeedback.fetchJson ───────────────────────────────────────────────────

describe("FormFeedback.fetchJson — the never-silent contract", () => {
  test("ok only for a 2xx success envelope; payload passes through", async () => {
    const { sandbox } = loadClient(["form-feedback.js"], {
      fetchImpl: jsonResponse(200, { status: "success", data: { n: 1 }, message: "Saved" }),
    });
    const r = await sandbox.window.FormFeedback.fetchJson("/x", { method: "POST", body: "{}" });
    expect(r.ok).toBe(true);
    expect(r.payload.data.n).toBe(1);
    expect(r.message).toBe("Saved");
  });

  test("200 with status:'failed' is NOT ok and surfaces the server message", async () => {
    const { sandbox } = loadClient(["form-feedback.js"], {
      fetchImpl: jsonResponse(400, { status: "failed", message: "Amount is required" }),
    });
    const r = await sandbox.window.FormFeedback.fetchJson("/x", { method: "POST", body: "{}" });
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Amount is required");
  });

  test("HTML login redirect becomes a session message, never a throw", async () => {
    const { sandbox } = loadClient(["form-feedback.js"], {
      fetchImpl: async () => ({ status: 200, redirected: true, text: async () => "<html>sign in</html>" }),
    });
    const r = await sandbox.window.FormFeedback.fetchJson("/x", { method: "POST", body: "{}" });
    expect(r.ok).toBe(false);
    expect(r.nonJson).toBe(true);
    expect(r.message).toMatch(/session expired/i);
  });

  test("non-JSON proxy error page reports the HTTP status", async () => {
    const { sandbox } = loadClient(["form-feedback.js"], {
      fetchImpl: async () => ({ status: 502, redirected: false, text: async () => "<html>Bad Gateway</html>" }),
    });
    const r = await sandbox.window.FormFeedback.fetchJson("/x");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/HTTP 502/);
  });

  test("dropped connection resolves (never rejects) with an actionable message", async () => {
    const { sandbox } = loadClient(["form-feedback.js"], {
      fetchImpl: async () => { throw new Error("Failed to fetch"); },
    });
    const r = await sandbox.window.FormFeedback.fetchJson("/x", { method: "POST", body: "{}" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.message).toMatch(/No response from the server/i);
  });

  test("auto-attaches CSRF + JSON content-type on POST; FormData keeps multipart", async () => {
    const calls = [];
    const { sandbox } = loadClient(["form-feedback.js"], {
      csrf: "tok-123",
      fetchImpl: async (url, opts) => { calls.push(opts); return { status: 200, redirected: false, text: async () => '{"status":"success"}' }; },
    });
    const FF = sandbox.window.FormFeedback;
    await FF.fetchJson("/x", { method: "POST", body: JSON.stringify({ a: 1 }) });
    await FF.fetchJson("/x", { method: "POST", body: new sandbox.FormData() });
    await FF.fetchJson("/x");
    expect(calls[0].headers["X-CSRF-Token"]).toBe("tok-123");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[1].headers["X-CSRF-Token"]).toBe("tok-123");
    expect(calls[1].headers["Content-Type"]).toBeUndefined();
    expect(calls[2].headers["X-CSRF-Token"]).toBeUndefined();
  });

  test("attaches Bearer token from the auth meta when present", async () => {
    const calls = [];
    const { sandbox } = loadClient(["form-feedback.js"], {
      auth: "jwt-abc",
      fetchImpl: async (url, opts) => { calls.push(opts); return { status: 200, redirected: false, text: async () => '{"status":"success"}' }; },
    });
    await sandbox.window.FormFeedback.fetchJson("/x");
    expect(calls[0].headers.Authorization).toBe("Bearer jwt-abc");
  });
});

// ── FormFeedback.busy / inline errors / status ───────────────────────────────

describe("FormFeedback.busy — no dead buttons, even after Back", () => {
  test("disables + relabels, restore() brings the button back exactly once", () => {
    const { sandbox, doc } = loadClient(["form-feedback.js"]);
    const btn = doc.createElement("button");
    btn.textContent = "Save";
    const restore = sandbox.window.FormFeedback.busy(btn, "Saving…");
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Saving…");
    restore();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Save");
    restore(); // idempotent
    expect(btn.textContent).toBe("Save");
  });

  test("bfcache pageshow(persisted) restores every busy button", () => {
    const { sandbox, doc, winListeners } = loadClient(["form-feedback.js"]);
    const btn = doc.createElement("button");
    btn.textContent = "Import";
    sandbox.window.FormFeedback.busy(btn, "Importing…");
    expect(btn.disabled).toBe(true);
    winListeners.pageshow.forEach((cb) => cb({ persisted: true }));
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Import");
  });

  test("non-persisted pageshow does not touch busy buttons", () => {
    const { sandbox, doc, winListeners } = loadClient(["form-feedback.js"]);
    const btn = doc.createElement("button");
    btn.textContent = "Save";
    sandbox.window.FormFeedback.busy(btn, "Saving…");
    winListeners.pageshow.forEach((cb) => cb({ persisted: false }));
    expect(btn.disabled).toBe(true);
  });
});

describe("FormFeedback inline field errors + form status", () => {
  test("setFieldError renders inside .field with aria wiring; clear removes it", () => {
    const { sandbox, doc } = loadClient(["form-feedback.js"]);
    const field = doc.createElement("div");
    field.className = "field";
    const input = doc.createElement("input");
    field.appendChild(input);
    doc.body.appendChild(field);
    const FF = sandbox.window.FormFeedback;

    FF.setFieldError(input, "Roll number is required");
    const err = field.querySelector(".field-error");
    expect(err.textContent).toBe("Roll number is required");
    expect(err.attrs.role).toBe("alert");
    expect(input.classList.contains("input-invalid")).toBe(true);
    expect(input.attrs["aria-invalid"]).toBe("true");

    FF.setFieldError(input, "New message"); // replaces, never stacks
    expect(field.querySelectorAll(".field-error").length).toBe(1);
    expect(field.querySelector(".field-error").textContent).toBe("New message");

    FF.clearFieldError(input);
    expect(field.querySelector(".field-error")).toBeNull();
    expect(input.classList.contains("input-invalid")).toBe(false);
    expect(input.attrs["aria-invalid"]).toBeUndefined();
  });

  test("clearFieldErrors sweeps a whole form", () => {
    const { sandbox, doc } = loadClient(["form-feedback.js"]);
    const form = doc.createElement("form");
    const field = doc.createElement("div");
    field.className = "field";
    const input = doc.createElement("input");
    field.appendChild(input);
    form.appendChild(field);
    doc.body.appendChild(form);
    const FF = sandbox.window.FormFeedback;
    FF.setFieldError(input, "bad");
    FF.clearFieldErrors(form);
    expect(form.querySelectorAll(".field-error").length).toBe(0);
    expect(form.querySelectorAll(".input-invalid").length).toBe(0);
  });

  test("statusFor creates a span beside the anchor and toggles ok/error", () => {
    const { sandbox, doc } = loadClient(["form-feedback.js"]);
    const btn = doc.createElement("button");
    doc.body.appendChild(btn);
    const st = sandbox.window.FormFeedback.statusFor(btn);
    st.set("Saved", true);
    const span = doc.body.querySelector(".form-status");
    expect(span.textContent).toBe("Saved");
    expect(span.classList.contains("ok")).toBe(true);
    st.set("Failed", false);
    expect(span.classList.contains("error")).toBe(true);
    expect(span.classList.contains("ok")).toBe(false);
    st.clear();
    expect(span.textContent).toBe("");
  });
});

// ── Toast ────────────────────────────────────────────────────────────────────

describe("Toast — feedback that cannot vanish or freeze the page", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const stackOf = (doc) => doc.getElementById("toast-stack");

  test("error toasts are sticky (no auto-dismiss) and announced as alert", () => {
    const { sandbox, doc } = loadClient(["toast.js"]);
    sandbox.window.Toast.error("Save failed");
    jest.advanceTimersByTime(60000);
    const stack = stackOf(doc);
    expect(stack.children.length).toBe(1);
    expect(stack.children[0].classList.contains("toast-error")).toBe(true);
    expect(stack.children[0].attrs.role).toBe("alert");
  });

  test("success toasts auto-dismiss after their timeout + exit animation", () => {
    const { sandbox, doc } = loadClient(["toast.js"]);
    sandbox.window.Toast.success("Saved");
    const stack = stackOf(doc);
    expect(stack.children.length).toBe(1);
    jest.advanceTimersByTime(4500);
    expect(stack.children[0].classList.contains("toast-out")).toBe(true);
    jest.advanceTimersByTime(200);
    expect(stack.children.length).toBe(0);
  });

  test("hover pauses the timer; leaving resumes with the remaining time", () => {
    const { sandbox, doc } = loadClient(["toast.js"]);
    const el = sandbox.window.Toast.success("Saved");
    jest.advanceTimersByTime(2000);
    el.dispatch("mouseenter");
    jest.advanceTimersByTime(30000); // reading for half a minute
    expect(stackOf(doc).children.length).toBe(1);
    el.dispatch("mouseleave");
    jest.advanceTimersByTime(2500 + 200); // remaining 2500ms + exit
    expect(stackOf(doc).children.length).toBe(0);
  });

  test("identical message+type deduplicates to one toast with a bump", () => {
    const { sandbox, doc } = loadClient(["toast.js"]);
    sandbox.window.Toast.warning("3 rows skipped");
    sandbox.window.Toast.warning("3 rows skipped");
    const stack = stackOf(doc);
    expect(stack.children.length).toBe(1);
    expect(stack.children[0].classList.contains("toast-bump")).toBe(true);
  });

  test("stack cap terminates under a burst and keeps sticky errors", () => {
    const { sandbox, doc } = loadClient(["toast.js"]);
    const T = sandbox.window.Toast;
    T.error("sticky failure");
    for (let i = 0; i < 12; i++) T.info("notice " + i);
    const stack = stackOf(doc);
    expect(stack.children.length).toBeLessThanOrEqual(5);
    expect(stack.children.some((c) => c.classList.contains("toast-error"))).toBe(true);
  });

  test("message content is text, never HTML (server messages embed user input)", () => {
    const { sandbox, doc } = loadClient(["toast.js"]);
    const payload = '<img src=x onerror="alert(1)"> & "quotes"';
    sandbox.window.Toast.error(payload);
    const msg = stackOf(doc).children[0].querySelector(".toast-msg");
    expect(msg.textContent).toBe(payload);
    expect(msg.children.length).toBe(0);
  });

  test("close button dismisses a sticky error", () => {
    const { sandbox, doc } = loadClient(["toast.js"]);
    sandbox.window.Toast.error("boom");
    stackOf(doc).children[0].querySelector(".toast-close").dispatch("click");
    jest.advanceTimersByTime(200);
    expect(stackOf(doc).children.length).toBe(0);
  });
});

// ── ConfirmDialog ────────────────────────────────────────────────────────────

describe("ConfirmDialog — always renders, always resolves (PWA-safe)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const overlayOf = (doc) => doc.body.querySelector(".confirm-overlay");
  const settle = async (p) => { jest.advanceTimersByTime(150); return p; };
  // ask() builds the overlay inside queue.then(...) — flush the microtask
  // chain before asserting on the DOM.
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

  test("confirm click resolves true and removes the overlay", async () => {
    const { sandbox, doc } = loadClient(["confirm-dialog.js"]);
    const p = sandbox.window.ConfirmDialog.ask({ title: "Delete?" });
    await flush();
    expect(overlayOf(doc)).not.toBeNull();
    overlayOf(doc).querySelector(".confirm-ok").dispatch("click");
    expect(await settle(p)).toBe(true);
    expect(overlayOf(doc)).toBeNull();
  });

  test("Cancel and Escape resolve false", async () => {
    const { sandbox, doc } = loadClient(["confirm-dialog.js"]);
    const p1 = sandbox.window.ConfirmDialog.ask({});
    await flush();
    overlayOf(doc).querySelector(".confirm-cancel").dispatch("click");
    expect(await settle(p1)).toBe(false);

    const p2 = sandbox.window.ConfirmDialog.ask({});
    await flush();
    doc.dispatch("keydown", { key: "Escape", preventDefault: jest.fn(), stopPropagation: jest.fn() });
    expect(await settle(p2)).toBe(false);
  });

  test("scrim press-and-release cancels; a drag ending on the scrim does not", async () => {
    const { sandbox, doc } = loadClient(["confirm-dialog.js"]);
    const p1 = sandbox.window.ConfirmDialog.ask({});
    await flush();
    const ov = overlayOf(doc);
    ov.dispatch("mousedown", { target: ov });
    ov.dispatch("mouseup", { target: ov });
    expect(await settle(p1)).toBe(false);

    const p2 = sandbox.window.ConfirmDialog.ask({});
    await flush();
    const ov2 = overlayOf(doc);
    ov2.dispatch("mousedown", { target: ov2.querySelector(".confirm-dialog") });
    ov2.dispatch("mouseup", { target: ov2 });
    jest.advanceTimersByTime(150);
    expect(overlayOf(doc)).not.toBeNull(); // still open
    ov2.querySelector(".confirm-ok").dispatch("click");
    expect(await settle(p2)).toBe(true);
  });

  test("danger dialogs focus Cancel (safe default); normal ones focus Confirm", async () => {
    const { sandbox, doc } = loadClient(["confirm-dialog.js"]);
    const p1 = sandbox.window.ConfirmDialog.ask({ danger: true });
    await flush();
    expect(doc.activeElement.classList.contains("confirm-cancel")).toBe(true);
    overlayOf(doc).querySelector(".confirm-cancel").dispatch("click");
    await settle(p1);

    const p2 = sandbox.window.ConfirmDialog.ask({});
    await flush();
    expect(doc.activeElement.classList.contains("confirm-ok")).toBe(true);
    overlayOf(doc).querySelector(".confirm-ok").dispatch("click");
    await settle(p2);
  });

  test("a second ask queues behind the first — never two scrims at once", async () => {
    const { sandbox, doc } = loadClient(["confirm-dialog.js"]);
    const CD = sandbox.window.ConfirmDialog;
    const p1 = CD.ask({ title: "First" });
    const p2 = CD.ask({ title: "Second" });
    await flush();
    expect(doc.body.querySelectorAll(".confirm-overlay").length).toBe(1);
    expect(doc.body.querySelector(".confirm-title").textContent).toBe("First");
    overlayOf(doc).querySelector(".confirm-ok").dispatch("click");
    expect(await settle(p1)).toBe(true);
    await flush();
    expect(doc.body.querySelectorAll(".confirm-overlay").length).toBe(1);
    expect(doc.body.querySelector(".confirm-title").textContent).toBe("Second");
    overlayOf(doc).querySelector(".confirm-ok").dispatch("click");
    expect(await settle(p2)).toBe(true);
    expect(doc.body.querySelectorAll(".confirm-overlay").length).toBe(0);
  });

  test("message newlines become paragraphs; content stays text", async () => {
    const { sandbox, doc } = loadClient(["confirm-dialog.js"]);
    const p = sandbox.window.ConfirmDialog.ask({ message: "Line one <b>x</b>\n\nLine two" });
    await flush();
    const msg = overlayOf(doc).querySelector(".confirm-message");
    expect(msg.children.length).toBe(2);
    expect(msg.children[0].textContent).toBe("Line one <b>x</b>");
    expect(msg.children[1].textContent).toBe("Line two");
    overlayOf(doc).querySelector(".confirm-cancel").dispatch("click");
    await settle(p);
  });
});