/**
 * Class-wise Attendance — per-day breakdown + specific missing-day label.
 *
 * The weekly institute report used to sum every class's week into one number
 * and flag a vague "incomplete" pill. Two changes are covered here:
 *
 *   1. The dashboard service keeps the class×day rows it already aggregates as
 *      a per-class `daily` map plus a `shortDays` list (the dates where the
 *      class has fewer records than it has active students) — no new query,
 *      the detail was previously thrown away.
 *   2. The rollup view route turns that into day columns (Mon, Tue, Wed …) that
 *      mirror the weekly trend chart, and into an
 *      "Incomplete: Wednesday, Thursday" label.
 *
 * Monthly / long ranges are no longer collapsed into summed cells: every marked
 * day gets its own column, the wrapper turns into a horizontally (and, for the
 * tall grid, vertically) scrollable container with the class-name column and the
 * date header pinned, and the "Incomplete" pill lists every gap in full ("Nov 3,
 * Nov 11 …") with no "+N more" cap. A single-day range still gets no day columns
 * and keeps the plain label; a range that fits a normal week (≤7 columns) is
 * unchanged — same columns, no scroll container, weekday-name gap labels.
 *
 * Pattern: real service + real view-route handler, models and apiFetch mocked
 * (attendanceDashboard.test.js + uiFeedbackRoutes.test.js).
 */

const mongoose = require("mongoose");

const mockAttendanceAggregate = jest.fn();
const mockStudentAggregate = jest.fn();
const mockClassLevelFind = jest.fn();

jest.mock("../models/Academic/attendance.model", () => ({
  aggregate: (...a) => mockAttendanceAggregate(...a),
}));
jest.mock("../models/Students/students.model", () => ({
  aggregate: (...a) => mockStudentAggregate(...a),
}));
jest.mock("../models/Academic/class.model", () => ({
  find: (...a) => mockClassLevelFind(...a),
}));

const mockApiFetch = jest.fn();
jest.mock("../utils/apiClient", () => ({
  apiFetch: (...args) => mockApiFetch(...args),
}));

jest.mock("../middlewares/authView", () => ({
  requireRole: () => (req, res, next) => next(),
  requireAdminOrManager: () => (req, res, next) => next(),
}));

const { getAttendanceDashboardService } = require("../services/academic/attendance.service");
const rollupRouter = require("../routes/views/attendanceRollup.views");

const CLASS_A = new mongoose.Types.ObjectId();
const CLASS_B = new mongoose.Types.ObjectId();
const CLASS_C = new mongoose.Types.ObjectId();

// ── service plumbing ────────────────────────────────────────────────────────

function fakeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// Route the two Attendance aggregates apart by their $group _id shape
// (class×day groups by an OBJECT, the day rollup by a string).
function stubAggregates(dayAgg, classDayAgg) {
  mockAttendanceAggregate.mockImplementation((pipeline) => {
    const groupId = pipeline[1] && pipeline[1].$group && pipeline[1].$group._id;
    if (groupId && typeof groupId === "object" && groupId.classLevel) {
      return Promise.resolve(classDayAgg);
    }
    return Promise.resolve(dayAgg);
  });
}

function stubStudents(countsByClass) {
  mockStudentAggregate.mockResolvedValue(
    Object.entries(countsByClass).map(([id, n]) => ({ _id: new mongoose.Types.ObjectId(id), n }))
  );
}

function stubClasses(docs) {
  mockClassLevelFind.mockReturnValue({
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(docs),
  });
}

const dayRow = (classId, date, present, absent, late) => ({
  _id: { classLevel: classId, date },
  present,
  absent,
  late,
  marked: present + absent + late,
});

async function runService(startDate, endDate) {
  const res = fakeRes();
  await getAttendanceDashboardService(startDate, endDate, "", true, res);
  return res.json.mock.calls[0][0].data;
}

// ── view-route plumbing ───────────────────────────────────────────────────────

function handler() {
  const layer = rollupRouter.stack.find(
    (l) => l.route && l.route.path === "/attendance/rollup" && l.route.methods.get
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function renderRollup(query, dash) {
  const res = {
    locals: { schoolName: "Test School" },
    render: jest.fn(),
    redirect: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  mockApiFetch.mockImplementation((url) =>
    Promise.resolve(
      url.startsWith("/class-levels")
        ? { status: "success", data: [] }
        : // the monthly re-fetch is irrelevant here — reuse the same payload
          { status: "success", data: dash }
    )
  );
  await handler()(
    { user: { _id: "u1", role: "admin" }, token: "tok", query, params: {}, body: {} },
    res
  );
  return res.render.mock.calls[0][1];
}

beforeEach(() => jest.clearAllMocks());

// ── 1. service keeps the per-day detail it already aggregates ────────────────

describe("dashboard service — per-class day detail", () => {
  test("exposes the daily map and the exact shortDays for a class with two unmarked days", async () => {
    // Week Mon 16 → Fri 20, 10 active students per class.
    const days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
    const classDayAgg = [];
    days.forEach((date) => {
      // Class A full Mon/Tue/Fri, nothing at all Wed/Thu.
      if (date !== "2026-11-18" && date !== "2026-11-19") {
        classDayAgg.push(dayRow(CLASS_A, date, 8, 2, 0));
      }
      // Class B full except Thursday, where only 6 of 10 got marked.
      classDayAgg.push(
        date === "2026-11-19" ? dayRow(CLASS_B, date, 4, 2, 0) : dayRow(CLASS_B, date, 7, 2, 1)
      );
      // Class C full every day.
      classDayAgg.push(dayRow(CLASS_C, date, 9, 1, 0));
    });

    const dayAgg = days.map((date) => ({
      _id: date,
      present: classDayAgg.filter((r) => r._id.date === date).reduce((s, r) => s + r.present, 0),
      absent: classDayAgg.filter((r) => r._id.date === date).reduce((s, r) => s + r.absent, 0),
      late: classDayAgg.filter((r) => r._id.date === date).reduce((s, r) => s + r.late, 0),
      marked: classDayAgg.filter((r) => r._id.date === date).reduce((s, r) => s + r.marked, 0),
    }));

    stubAggregates(dayAgg, classDayAgg);
    stubStudents({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10, [CLASS_C.toString()]: 10 });
    stubClasses([
      { _id: CLASS_A, name: "Class A" },
      { _id: CLASS_B, name: "Class B" },
      { _id: CLASS_C, name: "Class C" },
    ]);

    const data = await runService("2026-11-16", "2026-11-22");
    const [a, b, c] = ["Class A", "Class B", "Class C"].map((n) => data.classes.find((x) => x.name === n));

    expect(a.shortDays).toEqual(["2026-11-18", "2026-11-19"]);
    expect(b.shortDays).toEqual(["2026-11-19"]); // partial day counts as short
    expect(c.shortDays).toEqual([]);

    expect(a.incomplete).toBe(true);
    expect(b.incomplete).toBe(true);
    expect(c.incomplete).toBe(false);

    // Per-day cells carry the same rate formula as the range totals.
    expect(a.daily["2026-11-16"]).toMatchObject({ present: 8, absent: 2, late: 0, marked: 10 });
    expect(a.daily["2026-11-16"].rate).toBe(80);
    expect(a.daily["2026-11-18"]).toBeUndefined();
    expect(b.daily["2026-11-19"].marked).toBe(6);

    // The range totals the table already showed are unchanged.
    expect(a.marked).toBe(30);
    expect(a.coveredDays).toBe(3);
    expect(c.marked).toBe(50);
  });
});

// ── 2. rollup view route — day columns + specific incomplete label ───────────

describe("rollup view route — weekly class-wise breakdown", () => {
  const weekPayload = () => {
    const days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
    const classDayAgg = [];
    days.forEach((date) => {
      if (date !== "2026-11-18" && date !== "2026-11-19") classDayAgg.push(dayRow(CLASS_A, date, 8, 2, 0));
      classDayAgg.push(dayRow(CLASS_B, date, 7, 2, 1));
    });
    const dayAgg = days.map((date) => {
      const rows = classDayAgg.filter((r) => r._id.date === date);
      return {
        _id: date,
        present: rows.reduce((s, r) => s + r.present, 0),
        absent: rows.reduce((s, r) => s + r.absent, 0),
        late: rows.reduce((s, r) => s + r.late, 0),
        marked: rows.reduce((s, r) => s + r.marked, 0),
      };
    });
    stubAggregates(dayAgg, classDayAgg);
    stubStudents({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10 });
    stubClasses([{ _id: CLASS_A, name: "Class A" }, { _id: CLASS_B, name: "Class B" }]);
    return runService("2026-11-16", "2026-11-22");
  };

  test("a week range renders one column per marked day, Mon → Fri", async () => {
    const dash = await weekPayload();
    const vars = await renderRollup({ rangeType: "week", weekStart: "2026-11-16", scope: "institute" }, dash);

    expect(vars.classDayColumns.map((c) => c.label)).toEqual([
      "Mon 16", "Tue 17", "Wed 18", "Thu 19", "Fri 20",
    ]);
    expect(vars.classDayColumns.map((c) => c.date)).toEqual([
      "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
    ]);

    const a = vars.classRows.find((r) => r.name === "Class A");
    expect(a.dayCells.map((cell) => cell.date)).toEqual(vars.classDayColumns.map((c) => c.date));

    // Full day → green, nothing marked → grey, and the rate is the DAY's rate,
    // not the week's single aggregate number.
    expect(a.dayCells[0]).toMatchObject({ tone: "full", marked: 10, rate: 80, sortValue: 80 });
    expect(a.dayCells[2]).toMatchObject({ tone: "none", marked: 0, rate: null, sortValue: "" });
    expect(a.dayCells[3]).toMatchObject({ tone: "none" });
    expect(a.dayCells[4]).toMatchObject({ tone: "full" });

    // Week totals still there beside the new columns.
    expect(a.marked).toBe(30);
    expect(a.rate).toBeCloseTo(80, 0);
  });

  test("the incomplete pill names the missing days instead of 'Incomplete'", async () => {
    const dash = await weekPayload();
    const vars = await renderRollup({ rangeType: "week", weekStart: "2026-11-16", scope: "institute" }, dash);

    const a = vars.classRows.find((r) => r.name === "Class A");
    const b = vars.classRows.find((r) => r.name === "Class B");

    expect(a.incompleteLabel).toBe("Incomplete: Wednesday, Thursday");
    expect(a.incompleteTitle).toBe("2026-11-18: 0/10 marked · 2026-11-19: 0/10 marked");

    // A fully marked week shows no pill at all — the label only appears with
    // the flag that already existed.
    expect(b.incomplete).toBe(false);
    expect(b.incompleteLabel).toBe("incomplete");
  });

  test("daily view: no day columns and the label stays generic", async () => {
    stubAggregates(
      [{ _id: "2026-11-20", present: 12, absent: 4, late: 0, marked: 16 }],
      [dayRow(CLASS_A, "2026-11-20", 8, 2, 0), dayRow(CLASS_B, "2026-11-20", 4, 2, 0)]
    );
    stubStudents({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10 });
    stubClasses([{ _id: CLASS_A, name: "Class A" }, { _id: CLASS_B, name: "Class B" }]);

    const dash = await runService("2026-11-20", "2026-11-20");
    const vars = await renderRollup({ rangeType: "today", scope: "institute" }, dash);

    expect(vars.classDayColumns).toEqual([]);
    expect(vars.classRows.every((r) => r.dayCells.length === 0)).toBe(true);
    // Class B is short (6 of 10) — a single day has no "which day" to name.
    const b = vars.classRows.find((r) => r.name === "Class B");
    expect(b.incomplete).toBe(true);
    expect(b.incompleteLabel).toBe("incomplete");
    expect(b.incompleteTitle).toBe("Some students/days are unmarked in this range");
  });

  test("ranges longer than a week expand to a column per day and name every gap", async () => {
    // 10 marked days (Mon 16 → Wed 25); Class A misses both Wednesdays. Past a
    // week a bare weekday is ambiguous, so the label now reads by date.
    const days = [];
    for (let d = 16; d <= 25; d++) days.push(`2026-11-${d}`);
    const classDayAgg = [];
    days.forEach((date) => {
      if (date !== "2026-11-18" && date !== "2026-11-25") classDayAgg.push(dayRow(CLASS_A, date, 8, 2, 0));
      classDayAgg.push(dayRow(CLASS_B, date, 9, 1, 0));
    });
    const dayAgg = days.map((date) => {
      const rows = classDayAgg.filter((r) => r._id.date === date);
      return {
        _id: date,
        present: rows.reduce((s, r) => s + r.present, 0),
        absent: rows.reduce((s, r) => s + r.absent, 0),
        late: rows.reduce((s, r) => s + r.late, 0),
        marked: rows.reduce((s, r) => s + r.marked, 0),
      };
    });
    stubAggregates(dayAgg, classDayAgg);
    stubStudents({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10 });
    stubClasses([{ _id: CLASS_A, name: "Class A" }, { _id: CLASS_B, name: "Class B" }]);

    const dash = await runService("2026-11-16", "2026-11-30");
    const vars = await renderRollup({ rangeType: "month", year: "2026", month: "11", scope: "institute" }, dash);

    // No longer collapsed — one column per marked day, wider than a week → the
    // scroll container is requested.
    expect(vars.classDayColumns.map((c) => c.date)).toEqual(days);
    expect(vars.classWiseScroll).toBe(true);

    const a = vars.classRows.find((r) => r.name === "Class A");
    expect(a.dayCells.map((cell) => cell.date)).toEqual(days);
    expect(a.incompleteLabel).toBe("Incomplete: Nov 18, Nov 25");
    // Tooltip still carries the full per-day shortfall, dates and all.
    expect(a.incompleteTitle).toBe("2026-11-18: 0/10 marked · 2026-11-25: 0/10 marked");
  });

  test("monthly view renders a column for every marked day of the month", async () => {
    // A full working month: 25 marked days (Nov 2 → Nov 26). The old long-range
    // fallback summed these into a handful of columns; now every day stands
    // alone, and the grid is flagged for horizontal scroll.
    const monthDays = [];
    for (let d = 2; d <= 26; d++) monthDays.push(`2026-11-${String(d).padStart(2, "0")}`);
    const classDayAgg = [];
    monthDays.forEach((date) => {
      // Class A full every day; Class B full except a partial on Nov 26.
      classDayAgg.push(dayRow(CLASS_A, date, 8, 2, 0));
      classDayAgg.push(date === "2026-11-26" ? dayRow(CLASS_B, date, 5, 3, 0) : dayRow(CLASS_B, date, 9, 1, 0));
    });
    const dayAgg = monthDays.map((date) => {
      const rows = classDayAgg.filter((r) => r._id.date === date);
      return {
        _id: date,
        present: rows.reduce((s, r) => s + r.present, 0),
        absent: rows.reduce((s, r) => s + r.absent, 0),
        late: rows.reduce((s, r) => s + r.late, 0),
        marked: rows.reduce((s, r) => s + r.marked, 0),
      };
    });
    stubAggregates(dayAgg, classDayAgg);
    stubStudents({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10 });
    stubClasses([{ _id: CLASS_A, name: "Class A" }, { _id: CLASS_B, name: "Class B" }]);

    const dash = await runService("2026-11-01", "2026-11-30");
    const vars = await renderRollup({ rangeType: "month", year: "2026", month: "11", scope: "institute" }, dash);

    expect(vars.classDayColumns).toHaveLength(25);
    expect(vars.classDayColumns.map((c) => c.date)).toEqual(monthDays);
    expect(vars.classWiseScroll).toBe(true);

    const a = vars.classRows.find((r) => r.name === "Class A");
    expect(a.dayCells).toHaveLength(25);
    // A was marked in full every day → no gaps to list.
    expect(a.shortDays).toEqual([]);
    // B's lone partial day (Nov 26, 8 of 10) is the only gap, and it is named.
    const b = vars.classRows.find((r) => r.name === "Class B");
    expect(b.shortDays).toEqual(["2026-11-26"]);
    expect(b.incompleteLabel).toBe("Incomplete: Nov 26");
  });

  test("the incomplete list is uncapped for the month view (no '+N more')", async () => {
    // 25 marked days with Class A short on eight of them — under the old 5-name
    // cap this pill would have collapsed to "… +3 more". Now every gap shows.
    const shortSet = new Set([
      "2026-11-03", "2026-11-06", "2026-11-10", "2026-11-13",
      "2026-11-17", "2026-11-20", "2026-11-24", "2026-11-25",
    ]);
    const monthDays = [];
    for (let d = 2; d <= 26; d++) monthDays.push(`2026-11-${String(d).padStart(2, "0")}`);
    const classDayAgg = [];
    monthDays.forEach((date) => {
      // A: full (10 marked) except on the eight gap days (only 6 marked).
      classDayAgg.push(shortSet.has(date) ? dayRow(CLASS_A, date, 4, 2, 0) : dayRow(CLASS_A, date, 8, 2, 0));
      // B: complete every day → never flagged.
      classDayAgg.push(dayRow(CLASS_B, date, 9, 1, 0));
    });
    const dayAgg = monthDays.map((date) => {
      const rows = classDayAgg.filter((r) => r._id.date === date);
      return {
        _id: date,
        present: rows.reduce((s, r) => s + r.present, 0),
        absent: rows.reduce((s, r) => s + r.absent, 0),
        late: rows.reduce((s, r) => s + r.late, 0),
        marked: rows.reduce((s, r) => s + r.marked, 0),
      };
    });
    stubAggregates(dayAgg, classDayAgg);
    stubStudents({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10 });
    stubClasses([{ _id: CLASS_A, name: "Class A" }, { _id: CLASS_B, name: "Class B" }]);

    const dash = await runService("2026-11-01", "2026-11-30");
    const vars = await renderRollup({ rangeType: "month", year: "2026", month: "11", scope: "institute" }, dash);

    const a = vars.classRows.find((r) => r.name === "Class A");
    expect(a.shortDays).toHaveLength(8);
    expect(a.incompleteLabel).toBe(
      "Incomplete: Nov 3, Nov 6, Nov 10, Nov 13, Nov 17, Nov 20, Nov 24, Nov 25"
    );
    expect(a.incompleteLabel).not.toMatch(/more/);
  });

  test("a weekly range is still NOT flagged for the scroll container", async () => {
    const dash = await weekPayload();
    const vars = await renderRollup({ rangeType: "week", weekStart: "2026-11-16", scope: "institute" }, dash);
    // Five columns fit a normal week → plain table, weekday-name gap labels.
    expect(vars.classDayColumns).toHaveLength(5);
    expect(vars.classWiseScroll).toBe(false);
  });

  test("a class with no students at all never gets a gap label", async () => {
    const days = ["2026-11-16", "2026-11-17"];
    stubAggregates(
      days.map((date) => ({ _id: date, present: 8, absent: 2, late: 0, marked: 10 })),
      days.map((date) => dayRow(CLASS_A, date, 8, 2, 0))
    );
    stubStudents({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 0 });
    stubClasses([{ _id: CLASS_A, name: "Class A" }, { _id: CLASS_B, name: "Class B" }]);

    const dash = await runService("2026-11-16", "2026-11-22");
    const vars = await renderRollup({ rangeType: "week", weekStart: "2026-11-16", scope: "institute" }, dash);

    // Zero enrolled → the row is dropped entirely (unchanged rule), and the
    // surviving class is complete.
    expect(vars.classRows.map((r) => r.name)).toEqual(["Class A"]);
    expect(vars.classRows[0].shortDays).toEqual([]);
    expect(vars.classRows[0].incomplete).toBe(false);
  });
});

// ── 3. the real EJS template renders the new grid (compilation + markup) ────

const fs = require("fs");
const path = require("path");
const ejs = require("ejs");
const { safeJson } = require("../utils/safeJson");

const TEMPLATE = path.join(__dirname, "../views/attendance/rollup.ejs");
const SRC = fs.readFileSync(TEMPLATE, "utf8");

// filename makes the ../partials includes resolve, like res.render() does.
const renderTemplate = (vars) => ejs.render(SRC, { safeJson, ...vars }, { filename: TEMPLATE });

const classWise = (html) => html.match(/<table class="ledger" id="classWiseTable">[\s\S]*?<\/table>/)[0];

describe("rollup template — class-wise markup", () => {
  const stubWeek = async () => {
    const days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
    const classDayAgg = [];
    days.forEach((date) => {
      if (date !== "2026-11-18" && date !== "2026-11-19") classDayAgg.push(dayRow(CLASS_A, date, 8, 2, 0));
      // Class B is complete except Thursday, where only 6 of 10 got marked.
      classDayAgg.push(
        date === "2026-11-19" ? dayRow(CLASS_B, date, 4, 2, 0) : dayRow(CLASS_B, date, 7, 2, 1)
      );
    });
    stubAggregates(
      days.map((date) => {
        const rows = classDayAgg.filter((r) => r._id.date === date);
        return {
          _id: date,
          present: rows.reduce((s, r) => s + r.present, 0),
          absent: rows.reduce((s, r) => s + r.absent, 0),
          late: rows.reduce((s, r) => s + r.late, 0),
          marked: rows.reduce((s, r) => s + r.marked, 0),
        };
      }),
      classDayAgg
    );
    stubStudents({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10 });
    stubClasses([{ _id: CLASS_A, name: "Class A" }, { _id: CLASS_B, name: "Class B" }]);
    return runService("2026-11-16", "2026-11-22");
  };

  // A month-wide grid: 25 marked days (Nov 2 → Nov 26). Class A is short on the
  // 3rd, 6th and 10th (three gaps → the pill must list all three, no truncation
  // and the wider-than-a-week date format); Class B is complete throughout.
  const stubMonth = async () => {
    const shortSet = new Set(["2026-11-03", "2026-11-06", "2026-11-10"]);
    const monthDays = [];
    for (let d = 2; d <= 26; d++) monthDays.push(`2026-11-${String(d).padStart(2, "0")}`);
    const classDayAgg = [];
    monthDays.forEach((date) => {
      classDayAgg.push(shortSet.has(date) ? dayRow(CLASS_A, date, 4, 2, 0) : dayRow(CLASS_A, date, 8, 2, 0));
      classDayAgg.push(dayRow(CLASS_B, date, 9, 1, 0));
    });
    stubAggregates(
      monthDays.map((date) => {
        const rows = classDayAgg.filter((r) => r._id.date === date);
        return {
          _id: date,
          present: rows.reduce((s, r) => s + r.present, 0),
          absent: rows.reduce((s, r) => s + r.absent, 0),
          late: rows.reduce((s, r) => s + r.late, 0),
          marked: rows.reduce((s, r) => s + r.marked, 0),
        };
      }),
      classDayAgg
    );
    stubStudents({ [CLASS_A.toString()]: 10, [CLASS_B.toString()]: 10 });
    stubClasses([{ _id: CLASS_A, name: "Class A" }, { _id: CLASS_B, name: "Class B" }]);
    return runService("2026-11-01", "2026-11-30");
  };

  const varsFor = async (query, dash) => {
    const vars = await renderRollup(query, dash);
    return { ...vars, user: { role: "admin", name: "Ad Min", isManager: false } };
  };

  test("weekly render: five day columns, colour-coded cells, named gaps", async () => {
    const dash = await stubWeek();
    const html = renderTemplate(
      await varsFor({ rangeType: "week", weekStart: "2026-11-16", scope: "institute" }, dash)
    );
    const table = classWise(html);

    ["Mon 16", "Tue 17", "Wed 18", "Thu 19", "Fri 20"].forEach((label) =>
      expect(table).toContain(`>${label}</th>`)
    );
    expect(table).toContain(">Total</th>"); // summed columns still there

    // Wed/Thu were never marked for Class A → grey cells and an empty sort key
    expect((table.match(/cw-day cw-none/g) || [])).toHaveLength(2);
    expect(table).toContain('data-day-2026-11-18=""');
    // Class B's Thursday is partial → one amber cell
    expect((table.match(/cw-day cw-partial/g) || [])).toHaveLength(1);
    expect((table.match(/cw-day cw-full/g) || [])).toHaveLength(7);

    expect(table).toContain("Incomplete: Wednesday, Thursday");
    expect(table).toContain("Incomplete: Thursday");
    // Colour key mirrors the weekly chart, and stays CSP-clean (no inline JS)
    expect(table).not.toContain("<script");
    expect(html).toContain('<span class="key"><i style="background:#f59e0b;"></i> partial marking</span>');
    // A week fits the fixed table → no scroll container, no sticky column: the
    // weekly markup is byte-for-byte what it was before the monthly change.
    expect(html).not.toContain("table-wrap cw-scroll");
    expect(table).not.toContain("cw-col-sticky");
    expect(html).toContain('<div class="table-wrap">');
  });

  test("month render: a column per day inside a scroll container with pinned class column and header", async () => {
    const dash = await stubMonth();
    const html = renderTemplate(
      await varsFor({ rangeType: "month", year: "2026", month: "11", scope: "institute" }, dash)
    );
    const table = classWise(html);

    // 25 day columns rendered — nothing summed away.
    expect((table.match(/cw-day-head/g) || [])).toHaveLength(25);

    // The wrapper is the scroll container and the class-name cell is pinned in
    // the header and at the head of every one of the two rows.
    expect(html).toContain('<div class="table-wrap cw-scroll">');
    expect(table).toContain('class="th-sort cw-col-sticky" data-sort="name"');
    expect((table.match(/<td class="cw-col-sticky">/g) || [])).toHaveLength(2);

    // Uncapped, date-formatted gap list (three gaps → all three named, no "+N").
    expect(table).toContain("Incomplete: Nov 3, Nov 6, Nov 10");
    expect(table).not.toMatch(/ more/);

    // The scroll wrapper must not disturb the generic sorter: each column keeps
    // its data-sort="day-<date>" heading and every row its data-day-<date> value.
    ["2026-11-02", "2026-11-13", "2026-11-26"].forEach((date) => {
      expect(table).toContain(`data-sort="day-${date}"`);
      expect(table).toContain(`data-day-${date}=`);
    });
    // CSP-clean: the scroll markup adds no inline script.
    expect(table).not.toContain("<script");
  });

  test("daily render: the table markup is exactly what it was before", async () => {
    stubAggregates(
      [{ _id: "2026-11-16", present: 8, absent: 2, late: 0, marked: 10 }],
      [dayRow(CLASS_A, "2026-11-16", 6, 2, 0)]
    );
    stubStudents({ [CLASS_A.toString()]: 10 });
    stubClasses([{ _id: CLASS_A, name: "Class A" }]);

    const dash = await runService("2026-11-16", "2026-11-16");
    const vars = await varsFor({ rangeType: "today", scope: "institute" }, dash);
    const table = classWise(renderTemplate(vars));

    // Same five headings, no day cells, and the original lowercase pill wording
    expect((table.match(/<th /g) || [])).toHaveLength(5);
    expect(table).not.toContain("cw-day");
    expect(dash.classes[0].incomplete).toBe(true); // 6 of 10 marked
    expect(table).toContain(
      '<span class="pill review" title="Some students/days are unmarked in this range">incomplete</span>'
    );
  });
});
