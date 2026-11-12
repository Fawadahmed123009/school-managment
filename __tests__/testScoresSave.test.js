/**
 * Regression tests for the manual mark-entry page script
 * (public/js/test-scores.js, used by views/tests/roster.ejs).
 *
 * Bugs locked down:
 *  1. TDZ: updatePercentages()/currentMax() ran at load time while
 *     `totalMarksInput` was still declared lower in the IIFE. The ReferenceError
 *     killed the whole script on page load, so the Save listener never attached
 *     and the button silently did nothing.
 *  2. Dead Save button. Saving used to be a JS click handler calling
 *     form.submit() on a hidden form, and it left the button disabled with the
 *     label "Saving…" whenever the POST ended in a bfcache restore — after that
 *     the button fired nothing at all. Scores are now serialized on the FORM's
 *     submit event with #save-scores-btn as a native submit control: a page
 *     whose script never ran still posts (and the server flashes a readable
 *     reason) instead of presenting a dead button, and pageshow re-arms it.
 *  3. Silent failure. A rejected save has to say WHY — including when the API
 *     answers with something that is not JSON at all (an expired session, a
 *     proxy error page), which used to degrade to a bare "Save failed.".
 *
 * Loads the REAL script in a vm with a minimal DOM stub built from the actual
 * roster.ejs structure.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "public", "js", "test-scores.js"),
  "utf8"
);

function buildHarness({
  totalMarks = "25",
  rows = 3,
  fetchResponse = { status: "success" },
  fetchStatus = 200,
  fetchText = null, // when set, the body is NOT JSON (an error/login page)
  missing = [], // element ids to withhold (stale/cached markup simulation)
} = {}) {
  const handlers = new Map(); // node -> { event: fn }

  function node(extra = {}) {
    const n = {
      value: "",
      textContent: "",
      disabled: false,
      dataset: {},
      style: {},
      tagName: "DIV",
      addEventListener(ev, fn) {
        const map = handlers.get(n) || {};
        map[ev] = fn;
        handlers.set(n, map);
      },
      appendChild: jest.fn(),
      setAttribute: jest.fn(),
      focus: jest.fn(),
    };
    Object.assign(n, extra);
    return n;
  }

  // fire(node, event, [eventObject]) — submit/keydown handlers take an event.
  const fire = (n, ev, evt) => {
    const fn = (handlers.get(n) || {})[ev];
    if (!fn) throw new Error(`no ${ev} listener on element`);
    fn.call(n, evt);
  };

  const scoreInputs = [];
  const pctCells = [];
  const trs = [];
  for (let i = 0; i < rows; i++) {
    const input = node({ value: "", tagName: "INPUT" });
    const pct = node();
    scoreInputs.push(input);
    pctCells.push(pct);
    trs.push({
      style: {},
      dataset: { student: `stu-${i}`, roll: String(i + 1), name: `student ${i}` },
      querySelector: (sel) =>
        sel === ".score-input" ? input : sel === ".pct-cell" ? pct : null,
    });
  }

  const totalMarksInput = node({ value: totalMarks });
  const enteredCount = node();
  const saveBtn = node({ textContent: "Save scores", tagName: "BUTTON" });
  const recordsInput = node();
  const scoresForm = node();
  const sortRoll = node({ value: "" });
  const searchStudent = node({ value: "" });
  const rosterNoMatch = node();
  const rosterBody = node({
    querySelectorAll: () => trs,
    appendChild: () => {},
  });

  // Test-settings panel elements (fetch-based save, no page reload).
  const testSettingsEl = node({ dataset: { testId: "test-1" } });
  const saveSettingsBtn = node();
  const passMarksInput = node({ value: "10" });
  const settingsStatus = node();
  const scoresStatus = node();
  const body = node();

  const elements = {
    "total-marks-input": totalMarksInput,
    "entered-count": enteredCount,
    "save-scores-btn": saveBtn,
    "records-input": recordsInput,
    "scores-form": scoresForm,
    "sort-roll": sortRoll,
    "search-student": searchStudent,
    "roster-no-match": rosterNoMatch,
    "roster-body": rosterBody,
    "test-settings": testSettingsEl,
    "save-settings-btn": saveSettingsBtn,
    "pass-marks-input": passMarksInput,
    "settings-status": settingsStatus,
    "scores-status": scoresStatus,
  };
  missing.forEach((id) => delete elements[id]);

  const fetchMock = jest.fn(() =>
    Promise.resolve({
      status: fetchStatus,
      redirected: fetchStatus === 302,
      text: () =>
        Promise.resolve(
          fetchText != null ? fetchText : JSON.stringify(fetchResponse)
        ),
    })
  );

  const created = [];
  const document = {
    body,
    getElementById: (id) => elements[id] || null,
    createElement: () => {
      const n = node();
      created.push(n);
      return n;
    },
    querySelector: (sel) =>
      sel === 'meta[name="auth-token"]' ? { content: "fake-token" } : null,
    querySelectorAll: (sel) => {
      if (sel === ".score-input") return scoreInputs;
      if (sel === "#roster-body tr" || sel === "#roster-body tr[data-student]") return trs;
      return [];
    },
  };

  // window listeners (pageshow / bfcache restore).
  const windowHandlers = {};
  const window = {
    addEventListener: (ev, fn) => {
      windowHandlers[ev] = fn;
    },
  };

  const sandbox = {
    document,
    window,
    alert: jest.fn(),
    confirm: jest.fn(() => true),
    Number,
    String,
    JSON,
    Math,
    Array,
    Promise,
    Object,
    Error,
    fetch: fetchMock,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const fireWindow = (ev, obj) => windowHandlers[ev] && windowHandlers[ev](obj);

  // A submit/keydown event stub that records preventDefault().
  const submitEvent = (target) => {
    const e = { target, defaultPrevented: false };
    e.preventDefault = () => {
      e.defaultPrevented = true;
    };
    return e;
  };

  return {
    run: () => vm.runInContext(SRC, sandbox, { filename: "test-scores.js" }),
    fire,
    fireWindow,
    submitEvent,
    scoreInputs,
    pctCells,
    enteredCount,
    saveBtn,
    recordsInput,
    scoresForm,
    totalMarksInput,
    searchStudent,
    rosterNoMatch,
    trs,
    saveSettingsBtn,
    passMarksInput,
    settingsStatus,
    scoresStatus,
    scoresStatusNode: scoresStatus,
    fetchMock,
    created,
    body,
    confirm: sandbox.confirm,
    alert: sandbox.alert,
  };
}

describe("test-scores.js (mark a test — Save scores)", () => {
  test("loads without throwing (TDZ regression: updatePercentages before totalMarksInput declaration)", () => {
    const h = buildHarness();
    expect(() => h.run()).not.toThrow();
  });

  test("submitting the scores form fills records and lets the browser POST", () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "18";
    // row 1 stays blank → NO value supplied: the row is not sent at all, so a
    // stored score for that pupil can never be overwritten by a re-save
    // (marks-disappearing fix). Only an explicit "A" records an absence.
    h.scoreInputs[2].value = "0"; // a typed zero is a GENUINE score, not an absence

    const e = h.submitEvent();
    h.fire(h.scoresForm, "submit", e);

    // Not cancelled → the native submission proceeds (no JS-only dead end).
    expect(e.defaultPrevented).toBe(false);
    const records = JSON.parse(h.recordsInput.value);
    expect(records).toEqual([
      { student: "stu-0", score: 18 },
      { student: "stu-2", score: 0 },
    ]);
  });

  test('typing "A"/"a" marks the pupil absent — sent as the literal "A" (blanks are never sent)', () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "A";
    h.scoreInputs[1].value = "a";
    h.scoreInputs[2].value = "12";

    const e = h.submitEvent();
    h.fire(h.scoresForm, "submit", e);

    expect(e.defaultPrevented).toBe(false);
    const records = JSON.parse(h.recordsInput.value);
    expect(records).toEqual([
      { student: "stu-0", score: "A" },
      { student: "stu-1", score: "A" },
      { student: "stu-2", score: 12 },
    ]);
  });

  test("stray non-numeric text cancels the submission with a visible reason", () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "abc";
    const e = h.submitEvent();
    h.fire(h.scoresForm, "submit", e);

    expect(e.defaultPrevented).toBe(true);
    expect(h.scoresStatus.textContent).toMatch(/must be a number or "A"/i);
  });

  test("live percentage updates on input (also proves the load-time crash is gone)", () => {
    const h = buildHarness({ totalMarks: "25" });
    h.run();

    h.scoreInputs[1].value = "20";
    h.fire(h.scoreInputs[1], "input");
    expect(h.pctCells[1].textContent).toBe("80%");
    expect(h.enteredCount.textContent).toBe(1);
  });

  test("blocks the save with an inline message when a score exceeds the current total", () => {
    const h = buildHarness({ totalMarks: "25" });
    h.run();
    h.scoreInputs[0].value = "40";
    const e = h.submitEvent();
    h.fire(h.scoresForm, "submit", e);
    expect(e.defaultPrevented).toBe(true);
  });

  test("with no scores entered the save is blocked — blanks are never sent as absences", () => {
    const h = buildHarness();
    h.run();
    const e = h.submitEvent();
    h.fire(h.scoresForm, "submit", e);

    // Marks-disappearing regression: an all-blank roster must NOT post nulls
    // (the old blank→absence rule wiped stored scores on a stray re-save).
    expect(e.defaultPrevented).toBe(true);
    expect(h.scoresStatus.textContent).toMatch(/nothing to save/i);
    expect(h.recordsInput.value).toBe("");
  });

  test("typed-'A' rows save inline — no blocking confirm (PWA-safety regression)", () => {
    const h = buildHarness();
    h.run();
    h.scoreInputs[0].value = "18";
    h.scoreInputs[1].value = "A";
    // row 2 stays blank → not sent at all. Previously a confirm() gated
    // absences and a suppressed dialog aborted the save; now they commit
    // directly with an inline note.
    h.confirm.mockImplementation(() => false); // even a "declined" confirm is ignored

    const e = h.submitEvent();
    h.fire(h.scoresForm, "submit", e);

    expect(e.defaultPrevented).toBe(false);
    const records = JSON.parse(h.recordsInput.value);
    expect(records).toEqual([
      { student: "stu-0", score: 18 },
      { student: "stu-1", score: "A" },
    ]);
    expect(h.scoresStatus.textContent).toMatch(/1 pupil\(s\).*Absent/i);
  });

  // ── The dead-button regressions ───────────────────────────────────────────
  test("a cancelled save leaves the button usable (never stuck disabled)", () => {
    const h = buildHarness();
    h.run();
    h.scoreInputs[0].value = "abc";

    h.fire(h.scoresForm, "submit", h.submitEvent());
    h.fire(h.scoresForm, "submit", h.submitEvent());

    expect(h.saveBtn.disabled).toBe(false);
    expect(h.saveBtn.textContent).toBe("Save scores");
  });

  test("bfcache restore re-arms the button after an interrupted POST", () => {
    const h = buildHarness();
    h.run();

    // A genuine save leaves it in the in-flight state…
    h.scoreInputs[0].value = "18";
    h.fire(h.scoresForm, "submit", h.submitEvent());
    expect(h.saveBtn.textContent).toBe("Saving…");

    // …and the browser restoring the page must clear it, or the next click on a
    // disabled button does nothing at all (the reported "Save stopped working").
    h.fireWindow("pageshow", { persisted: true });
    expect(h.saveBtn.disabled).toBe(false);
    expect(h.saveBtn.textContent).toBe("Save scores");
    expect(h.scoresStatus.textContent).toBe("");
  });

  test("a normal (non-restored) pageshow does not touch the button", () => {
    const h = buildHarness();
    h.run();
    h.scoreInputs[0].value = "18";
    h.fire(h.scoresForm, "submit", h.submitEvent());

    h.fireWindow("pageshow", { persisted: false });
    expect(h.saveBtn.textContent).toBe("Saving…");
  });

  test("Enter inside the roster cancels implicit submit — blanks would save as absences", () => {
    const h = buildHarness();
    h.run();

    const e = h.submitEvent(h.scoreInputs[0]);
    e.key = "Enter";
    h.fire(h.scoresForm, "keydown", e);

    expect(e.defaultPrevented).toBe(true);
    expect(h.scoreInputs[1].focus).toHaveBeenCalled(); // focus advances instead
  });

  test("other keys are left to the browser", () => {
    const h = buildHarness();
    h.run();

    const e = h.submitEvent(h.scoreInputs[0]);
    e.key = "2";
    h.fire(h.scoresForm, "keydown", e);

    expect(e.defaultPrevented).toBe(false);
  });

  test("a missing records field is reported instead of posting an empty payload", () => {
    const h = buildHarness({ missing: ["records-input"] });
    h.run();

    const e = h.submitEvent();
    h.fire(h.scoresForm, "submit", e);

    expect(e.defaultPrevented).toBe(true);
    expect(h.scoresStatus.textContent).toMatch(/form is missing|reload the page/i);
  });

  test("feedback is still shown when the markup has no status element (stale page)", () => {
    const h = buildHarness({ missing: ["scores-status"] });
    h.run();

    h.scoreInputs[0].value = "abc";
    h.fire(h.scoresForm, "submit", h.submitEvent());

    // A synthesized node is appended so the reason is never written to nothing —
    // inside the form, next to the Save button the teacher just pressed.
    expect(h.created.length).toBe(1);
    expect(h.created[0].textContent).toMatch(/must be a number or "A"/i);
    expect(h.scoresForm.appendChild).toHaveBeenCalledWith(h.created[0]);
  });

  // ── Search / sort behaviour ───────────────────────────────────────────────
  test("search filters the roster by name, hiding non-matching rows", () => {
    const h = buildHarness();
    h.run();

    h.searchStudent.value = "student 1";
    h.fire(h.searchStudent, "input");

    expect(h.trs[0].style.display).toBe("none"); // student 0 hidden
    expect(h.trs[1].style.display).toBe(""); // student 1 visible
    expect(h.trs[2].style.display).toBe("none"); // student 2 hidden
    expect(h.rosterNoMatch.style.display).toBe("none"); // matches exist → no placeholder
  });

  test("search matches on roll number too", () => {
    const h = buildHarness();
    h.run();

    h.searchStudent.value = "3"; // roll "3" → only stu-2
    h.fire(h.searchStudent, "input");

    expect(h.trs[0].style.display).toBe("none");
    expect(h.trs[1].style.display).toBe("none");
    expect(h.trs[2].style.display).toBe("");
  });

  test("a search with no matches reveals the placeholder row", () => {
    const h = buildHarness();
    h.run();

    h.searchStudent.value = "zzz-nobody";
    h.fire(h.searchStudent, "input");

    expect(h.trs.every((t) => t.style.display === "none")).toBe(true);
    expect(h.rosterNoMatch.style.display).toBe("");
  });

  test("clearing the search reveals every row again", () => {
    const h = buildHarness();
    h.run();

    h.searchStudent.value = "student 1";
    h.fire(h.searchStudent, "input");
    h.searchStudent.value = "";
    h.fire(h.searchStudent, "input");

    expect(h.trs.every((t) => t.style.display === "")).toBe(true);
    expect(h.rosterNoMatch.style.display).toBe("none");
  });

  test("marks entered for a pupil are still saved after the search hides their row", () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "18"; // mark student 0
    h.searchStudent.value = "student 2"; // then search away from them
    h.fire(h.searchStudent, "input");
    expect(h.trs[0].style.display).toBe("none");

    h.fire(h.scoresForm, "submit", h.submitEvent());
    const records = JSON.parse(h.recordsInput.value);
    expect(records).toContainEqual({ student: "stu-0", score: 18 }); // still committed
  });
});

const flush = () => new Promise((r) => setImmediate(r));

describe("test-scores.js (mark a test — save total/pass marks without reload)", () => {
  test("clicking Save PATCHes the marks API and does NOT reload/submit the scores form", async () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "18"; // a score already typed, not yet saved
    h.totalMarksInput.value = "20";
    h.passMarksInput.value = "10";

    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.fetchMock).toHaveBeenCalledWith(
      "/api/v1/tests/test-1/marks",
      expect.objectContaining({ method: "PATCH" })
    );
    // The typed score survives the in-place save.
    expect(h.scoreInputs[0].value).toBe("18");
    expect(h.settingsStatus.textContent).toBe("Saved.");
  });

  test("a successful save re-ceils every score input and refreshes percentages", async () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[1].value = "10"; // 10 / new total 20 = 50%
    h.totalMarksInput.value = "20";

    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.scoreInputs[1].dataset.max).toBe(20);
    expect(h.pctCells[1].textContent).toBe("50%");
  });

  test("pass marks greater than total is blocked client-side (no request sent)", async () => {
    const h = buildHarness();
    h.run();

    h.totalMarksInput.value = "20";
    h.passMarksInput.value = "50";

    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.settingsStatus.textContent).toMatch(/cannot exceed total/i);
  });

  // A cleared field used to reach the API as NaN → JSON null → written as 0.
  test("a cleared pass-marks field is refused locally, never sent", async () => {
    const h = buildHarness();
    h.run();

    h.totalMarksInput.value = "20";
    h.passMarksInput.value = "";

    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.settingsStatus.textContent).toMatch(/Pass marks is required/i);
  });

  test("a server rejection is surfaced inline and still does not reload", async () => {
    const h = buildHarness({
      fetchResponse: { status: "failed", message: "Existing scores exceed the new total" },
    });
    h.run();

    h.totalMarksInput.value = "5";
    h.passMarksInput.value = "2"; // valid scale so the client guard passes
    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.settingsStatus.textContent).toBe("Existing scores exceed the new total");
  });

  test("a 500 whose body is not JSON says so, instead of a bare 'Save failed.'", async () => {
    const h = buildHarness({
      fetchStatus: 500,
      fetchText: "<!doctype html><h1>Internal Server Error</h1>",
    });
    h.run();

    h.totalMarksInput.value = "50";
    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.settingsStatus.textContent).toMatch(/unexpected page \(HTTP 500\)/i);
  });

  test("a 401/403 JSON refusal is reported with the server's reason", async () => {
    const h = buildHarness({
      fetchStatus: 403,
      fetchResponse: {
        status: "failed",
        message: "This request came from an address the site does not accept.",
      },
    });
    h.run();

    h.totalMarksInput.value = "50";
    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.settingsStatus.textContent).toMatch(/address the site does not accept/i);
  });

  test("an offline failure (fetch rejects) still reports inline and re-enables", async () => {
    const h = buildHarness();
    h.run();
    h.fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));

    h.totalMarksInput.value = "50";
    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.settingsStatus.textContent).toMatch(/check the connection|no response from the server/i);
    expect(h.settingsStatus.textContent).not.toMatch(/Failed to fetch/i);
    expect(h.saveSettingsBtn.disabled).toBe(false);
  });

  test("saving scores where a value exceeds the total shows an inline warning and blocks the save", () => {
    const h = buildHarness({ totalMarks: "20" });
    h.run();

    h.scoreInputs[0].value = "25"; // above the current total of 20
    const e = h.submitEvent();
    h.fire(h.scoresForm, "submit", e);

    // No blocking alert(): reported inline so a suppressed PWA dialog can't
    // hide the reason the save was refused.
    expect(h.scoresStatus.textContent).toMatch(/between 0 and 20/i);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("views/tests/roster.ejs — Save degrades gracefully without page JS", () => {
  const ejs = fs.readFileSync(
    path.join(__dirname, "..", "views", "tests", "roster.ejs"),
    "utf8"
  );

  // The whole point of the restructure: the save is a NATIVE form submission.
  // If the page script never runs (stale cached copy, an error at load), the
  // button must still post, so the server's flash explains the empty payload
  // rather than the teacher staring at a control that does nothing.
  test("the Save control is a type=submit button inside the scores form", () => {
    expect(ejs).toMatch(/<form[^>]*id="scores-form"[^>]*method="POST"/i);
    const formStart = ejs.indexOf('id="scores-form"');
    const btn = /<button\s+type="submit"[^>]*id="save-scores-btn"/.exec(ejs);
    expect(btn).not.toBeNull();
    expect(formStart).toBeGreaterThan(-1);
    expect(ejs.indexOf(btn[0])).toBeGreaterThan(formStart);
  });

  test("CSRF and records ride inside that form (no hidden detached form)", () => {
    expect(ejs).toMatch(/<input type="hidden" name="_csrf"/);
    expect(ejs).toMatch(/<input type="hidden" name="records" id="records-input"/);
    expect(ejs).not.toMatch(/style="display:none;">\s*<input[^>]*_csrf/);
  });
});
