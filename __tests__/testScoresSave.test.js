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

function buildHarness({ totalMarks = "25", rows = 3 } = {}) {
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
      dataset: { student: `stu-${i}`, roll: String(i + 1) },
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
  const rosterBody = node({
    querySelectorAll: () => trs,
    appendChild: () => {},
  });

  const document = {
    getElementById: (id) =>
      ({
        "total-marks-input": totalMarksInput,
        "entered-count": enteredCount,
        "save-scores-btn": saveBtn,
        "records-input": recordsInput,
        "scores-form": scoresForm,
        "sort-roll": sortRoll,
        "roster-body": rosterBody,
      })[id] || null,
    querySelectorAll: (sel) => {
      if (sel === ".score-input") return scoreInputs;
      if (sel === "#roster-body tr") return trs;
      return [];
    },
  };

  const sandbox = { document, window: {}, alert: jest.fn(), Number, String, JSON, Math, Array };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  return { run: () => vm.runInContext(SRC, sandbox, { filename: "test-scores.js" }), fire, scoreInputs, pctCells, enteredCount, saveBtn, recordsInput, scoresForm, totalMarksInput };
}

describe("test-scores.js (mark a test — Save scores)", () => {
  test("loads without throwing (TDZ regression: updatePercentages before totalMarksInput declaration)", () => {
    const h = buildHarness();
    expect(() => h.run()).not.toThrow();
  });

  test("clicking Save scores fills records-input and submits the form", () => {
    const h = buildHarness();
    h.run();

    h.scoreInputs[0].value = "18";
    h.scoreInputs[2].value = "0"; // a legit zero must be saved, not dropped
    h.fire(h.saveBtn, "click");

    expect(h.scoresForm.submit).toHaveBeenCalledTimes(1);
    const records = JSON.parse(h.recordsInput.value);
    expect(records).toEqual([
      { student: "stu-0", score: 18 },
      { student: "stu-2", score: 0 },
    ]);
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

  test("with no scores entered nothing is submitted", () => {
    const h = buildHarness();
    h.run();
    h.fire(h.saveBtn, "click");
    expect(h.scoresForm.submit).not.toHaveBeenCalled();
  });
});
