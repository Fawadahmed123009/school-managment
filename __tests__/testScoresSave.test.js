/**
 * Regression tests for the manual mark-entry page script
 * (public/js/test-scores.js, used by views/tests/roster.ejs).
 *
 * Bug locked down: updatePercentages()/currentMax() ran at load time while
 * `totalMarksInput` was still in its temporal dead zone (declared lower in the
 * IIFE). The ReferenceError killed the whole script on page load, so the
 * "Save scores" click listener never attached and the button silently did
 * nothing (no POST ever reached the server).
 *
 * Loads the REAL script in a vm with a minimal DOM stub built from the actual
 * roster.ejs structure and asserts: clean load, live %, and a working save
 * that fills #records-input and submits #scores-form.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "public", "js", "test-scores.js"),
  "utf8"
);

function buildHarness({ totalMarks = "25", rows = 3, fetchResponse = { status: "success" } } = {}) {
  const handlers = new Map(); // node -> { event: fn }

  function node(extra = {}) {
    const n = {
      value: "",
      textContent: "",
      disabled: false,
      dataset: {},
      style: {},
      addEventListener(ev, fn) {
        const map = handlers.get(n) || {};
        map[ev] = fn;
        handlers.set(n, map);
      },
    };
    Object.assign(n, extra);
    return n;
  }

  const fire = (n, ev) => {
    const fn = (handlers.get(n) || {})[ev];
    if (!fn) throw new Error(`no ${ev} listener on element`);
    fn.call(n);
  };

  const scoreInputs = [];
  const pctCells = [];
  const trs = [];
  for (let i = 0; i < rows; i++) {
    const input = node({ value: "" });
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
  const saveBtn = node();
  const recordsInput = node();
  const scoresForm = node({ submit: jest.fn() });
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

  const fetchMock = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve(fetchResponse) })
  );

  const document = {
    getElementById: (id) =>
      ({
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
      })[id] || null,
    querySelector: (sel) =>
      sel === 'meta[name="auth-token"]' ? { content: "fake-token" } : null,
    querySelectorAll: (sel) => {
      if (sel === ".score-input") return scoreInputs;
      if (sel === "#roster-body tr" || sel === "#roster-body tr[data-student]") return trs;
      return [];
    },
  };

  const sandbox = { document, window: {}, alert: jest.fn(), confirm: jest.fn(() => true), Number, String, JSON, Math, Array, Promise, Object, fetch: fetchMock };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  return { run: () => vm.runInContext(SRC, sandbox, { filename: "test-scores.js" }), fire, scoreInputs, pctCells, enteredCount, saveBtn, recordsInput, scoresForm, totalMarksInput, searchStudent, rosterNoMatch, trs, saveSettingsBtn, passMarksInput, settingsStatus, fetchMock, confirm: sandbox.confirm, alert: sandbox.alert };
}

describe("test-scores.js (mark a test — Save scores)", () => {
  test("loads without throwing (TDZ regression: updatePercentages before totalMarksInput declaration)", () => {
    const h = buildHarness();
    expect(() => h.run()).not.toThrow();
  });

  test("clicking Save scores submits EVERY row — blanks become Absent (null), typed values numeric", () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "18";
    // row 1 stays blank → absence (null, server stores as A / excluded from avg)
    h.scoreInputs[2].value = "0"; // a typed zero is a GENUINE score, not an absence

    h.fire(h.saveBtn, "click");

    expect(h.scoresForm.submit).toHaveBeenCalledTimes(1);
    const records = JSON.parse(h.recordsInput.value);
    expect(records).toEqual([
      { student: "stu-0", score: 18 },
      { student: "stu-1", score: null },
      { student: "stu-2", score: 0 },
    ]);
  });

  test('typing "A"/"a" marks the pupil absent — sent as null, exactly like a blank box', () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "A";
    h.scoreInputs[1].value = "a";
    h.scoreInputs[2].value = "12";

    h.fire(h.saveBtn, "click");

    expect(h.scoresForm.submit).toHaveBeenCalledTimes(1);
    const records = JSON.parse(h.recordsInput.value);
    expect(records).toEqual([
      { student: "stu-0", score: null },
      { student: "stu-1", score: null },
      { student: "stu-2", score: 12 },
    ]);
  });

  test("stray non-numeric text blocks the save (no silent NaN → absence)", () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "abc";
    h.fire(h.saveBtn, "click");

    expect(h.scoresForm.submit).not.toHaveBeenCalled();
  });

  test("live percentage updates on input (also proves the load-time crash is gone)", () => {
    const h = buildHarness({ totalMarks: "25" });
    h.run();

    h.scoreInputs[1].value = "20";
    h.fire(h.scoreInputs[1], "input");
    expect(h.pctCells[1].textContent).toBe("80%");
    expect(h.enteredCount.textContent).toBe(1);
  });

  test("blocks the save with a readable alert when a score exceeds the current total", () => {
    const h = buildHarness({ totalMarks: "25" });
    h.run();
    h.scoreInputs[0].value = "40";
    h.fire(h.saveBtn, "click");
    expect(h.scoresForm.submit).not.toHaveBeenCalled();
  });

  test("with no scores entered every pupil is still saved as Absent (blank → A)", () => {
    const h = buildHarness();
    h.run();
    h.fire(h.saveBtn, "click");

    // Blanks are an explicit absence, not a silent skip — the form submits.
    expect(h.scoresForm.submit).toHaveBeenCalledTimes(1);
    const records = JSON.parse(h.recordsInput.value);
    expect(records).toEqual([
      { student: "stu-0", score: null },
      { student: "stu-1", score: null },
      { student: "stu-2", score: null },
    ]);
  });

  test("cancelling the absence confirmation aborts the save", () => {
    const h = buildHarness();
    h.run();
    h.scoreInputs[0].value = "18";
    h.confirm.mockImplementation(() => false); // teacher declines marking the rest absent

    h.fire(h.saveBtn, "click");
    expect(h.scoresForm.submit).not.toHaveBeenCalled();
  });

  test("search filters the roster by name, hiding non-matching rows", () => {
    const h = buildHarness();
    h.run();

    h.searchStudent.value = "student 1";
    h.fire(h.searchStudent, "input");

    expect(h.trs[0].style.display).toBe("none"); // student 0 hidden
    expect(h.trs[1].style.display).toBe("");     // student 1 visible
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

    h.scoreInputs[0].value = "18";      // mark student 0
    h.searchStudent.value = "student 2"; // then search away from them
    h.fire(h.searchStudent, "input");
    expect(h.trs[0].style.display).toBe("none");

    h.fire(h.saveBtn, "click");
    const records = JSON.parse(h.recordsInput.value);
    expect(records).toContainEqual({ student: "stu-0", score: 18 }); // still committed
  });
});

const flush = () => new Promise((r) => setImmediate(r));

describe("test-scores.js (mark a test — save total/pass marks without reload)", () => {
  test("clicking Save PATCHes the marks API and does NOT reload/submit the scores form", async () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "18";   // a score already typed, not yet saved
    h.totalMarksInput.value = "20";
    h.passMarksInput.value = "10";

    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.fetchMock).toHaveBeenCalledWith(
      "/api/v1/tests/test-1/marks",
      expect.objectContaining({ method: "PATCH" })
    );
    // No navigation: the scores form is never submitted by the settings save.
    expect(h.scoresForm.submit).not.toHaveBeenCalled();
    // The typed score survives the in-place save.
    expect(h.scoreInputs[0].value).toBe("18");
    expect(h.settingsStatus.textContent).toBe("Saved.");
  });

  test("a successful save re-ceils every score input and refreshes percentages", async () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[1].value = "10";   // 10 / new total 20 = 50%
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

  test("a server rejection is surfaced inline and still does not reload", async () => {
    const h = buildHarness({ fetchResponse: { status: "failed", message: "Existing scores exceed the new total" } });
    h.run();

    h.totalMarksInput.value = "5";
    h.passMarksInput.value = "2"; // valid scale so the client guard passes
    h.fire(h.saveSettingsBtn, "click");
    await flush();

    expect(h.settingsStatus.textContent).toBe("Existing scores exceed the new total");
    expect(h.scoresForm.submit).not.toHaveBeenCalled();
  });

  test("saving scores where a value exceeds the total pops a warning and blocks the save", () => {
    const h = buildHarness({ totalMarks: "20" });
    h.run();

    h.scoreInputs[0].value = "25"; // above the current total of 20
    h.fire(h.saveBtn, "click");

    expect(h.alert).toHaveBeenCalled();
    expect(h.scoresForm.submit).not.toHaveBeenCalled();
  });
});
