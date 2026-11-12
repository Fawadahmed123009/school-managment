/**
 * Collections report date-range regression (GET /api/v1/fees/collection/report
 * and the /fees/collection view share getDailyCollectionData).
 *
 * Bug: the from/to branch queried { $gte: new Date(from), $lte: new Date(to) }
 * — UTC midnights — so a range dropped the final day's payments and any
 * first-day payments made before UTC midnight (00:00–05:00 PKT). Confirmed
 * case: from=2026-11-01&to=2026-11-30 returned Rs 1000 of Rs 6000.
 *
 * The Fees model is mocked with an in-memory matcher that applies WHATEVER
 * filter the service builds, so these tests fail against the old UTC bounds
 * and pass with the shared inclusive local-day helper (utils/dateRange).
 * Grouping/totals/response shape are asserted unchanged.
 */

const mockFeesFind = jest.fn();

jest.mock("../models/Fees/fees.model", () => ({
  find: (...a) => mockFeesFind(...a),
}));
jest.mock("../models/Fees/feeHead.model", () => ({}));
jest.mock("../models/Students/students.model", () => ({}));
jest.mock("../utils/paginate", () => ({ paginate: jest.fn() }));

const mongoose = require("mongoose");
const { getDailyCollectionData } = require("../services/fees/feeHead.service");
const { todayKey } = require("../utils/dateRange");

// Local-calendar instants (server TZ) — the PKT boundary cases.
const NOV1_EARLY = new Date(2026, 10, 1, 0, 30); // 00:30 PKT = Oct 31 19:30Z
const NOV1_MIDNIGHT = new Date(2026, 10, 1, 0, 0);
const NOV15 = new Date(2026, 10, 15, 12, 0);
const NOV30_MID = new Date(2026, 10, 30, 12, 0);
const NOV30_LATE = new Date(2026, 10, 30, 23, 59);
const DEC1_MIDNIGHT = new Date(2026, 11, 1, 0, 0);
const DEC1_EARLY = new Date(2026, 11, 1, 0, 30);
const OCT31_LATE = new Date(2026, 9, 31, 23, 0);

const doc = (amount, datePaid) => ({
  _id: new mongoose.Types.ObjectId(),
  amount,
  datePaid,
  status: "paid",
  feeType: "Tuition",
  feeHead: { name: "Tuition" },
  student: {
    name: "Probe Student",
    rollNumber: "1",
    classLevel: { gradeLevel: "5", name: "Blue", section: "A" },
  },
});

// The confirmed Rs 1000 → Rs 6000 case: early-first-day 2000 + mid 1000 +
// last-day 3000. Old UTC bounds kept only the mid row (Rs 1000).
const CASE_6000 = [doc(2000, NOV1_EARLY), doc(1000, NOV15), doc(3000, NOV30_MID)];

// Applies the service's actual filter in memory (Mongo date-bound semantics).
function matchDocs(docs, filter) {
  return docs.filter((d) => {
    if (filter.status && d.status !== filter.status) return false;
    const b = filter.datePaid || {};
    const t = d.datePaid.getTime();
    if (b.$gte && t < b.$gte.getTime()) return false;
    if (b.$gt && t <= b.$gt.getTime()) return false;
    if (b.$lte && t > b.$lte.getTime()) return false;
    if (b.$lt && t >= b.$lt.getTime()) return false;
    return true;
  });
}

let lastFilter = null;
function seed(docs) {
  mockFeesFind.mockImplementation((filter) => {
    lastFilter = filter;
    const rows = matchDocs(docs, filter).sort((a, b) => a.datePaid - b.datePaid);
    return {
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(rows),
    };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  lastFilter = null;
});

describe("getDailyCollectionData — inclusive local range (Rs 1000 → Rs 6000 regression)", () => {
  it("from=Nov1&to=Nov30 totals Rs 6000: first-day early-PKT + last-day payments included", async () => {
    seed(CASE_6000);
    const report = await getDailyCollectionData({ from: "2026-11-01", to: "2026-11-30" });
    expect(report.grandTotal).toBe(6000); // old UTC $gte/$lte returned 1000
    expect(report.totalRecords).toBe(3);
  });

  it("builds [from local midnight, to local midnight + 1 day) — no $lte", async () => {
    seed(CASE_6000);
    await getDailyCollectionData({ from: "2026-11-01", to: "2026-11-30" });
    expect(lastFilter.datePaid.$gte).toEqual(new Date(2026, 10, 1));
    expect(lastFilter.datePaid.$lt).toEqual(new Date(2026, 11, 1));
    expect(lastFilter.datePaid.$lte).toBeUndefined();
    expect(lastFilter.status).toBe("paid"); // paid-only scope unchanged
  });

  it("payment exactly at first-day local midnight is included; prior day excluded", async () => {
    seed([doc(2000, NOV1_MIDNIGHT), doc(500, OCT31_LATE)]);
    const report = await getDailyCollectionData({ from: "2026-11-01", to: "2026-11-30" });
    expect(report.grandTotal).toBe(2000);
    expect(report.totalRecords).toBe(1);
  });

  it("payment at 23:59 on the last day is included; next-day midnight excluded", async () => {
    seed([doc(3000, NOV30_LATE), doc(700, DEC1_MIDNIGHT)]);
    const report = await getDailyCollectionData({ from: "2026-11-01", to: "2026-11-30" });
    expect(report.grandTotal).toBe(3000);
    expect(report.totalRecords).toBe(1);
  });

  it("payments outside the range stay excluded on both sides", async () => {
    seed([...CASE_6000, doc(500, OCT31_LATE), doc(700, DEC1_EARLY)]);
    const report = await getDailyCollectionData({ from: "2026-11-01", to: "2026-11-30" });
    expect(report.grandTotal).toBe(6000);
    expect(report.totalRecords).toBe(3);
  });

  it("from == to covers exactly that one local day", async () => {
    seed([doc(3000, NOV30_MID), doc(700, DEC1_EARLY), doc(2000, NOV1_EARLY)]);
    const report = await getDailyCollectionData({ from: "2026-11-30", to: "2026-11-30" });
    expect(report.grandTotal).toBe(3000);
    expect(report.totalRecords).toBe(1);
  });

  it("from > to still yields an empty report (legacy behavior preserved)", async () => {
    seed(CASE_6000);
    const report = await getDailyCollectionData({ from: "2026-12-01", to: "2026-11-01" });
    expect(report.grandTotal).toBe(0);
    expect(report.totalRecords).toBe(0);
  });
});

describe("getDailyCollectionData — single date and default today", () => {
  it("date=Nov30 covers the whole LOCAL day (00:30 → 23:59), not the UTC day", async () => {
    seed([doc(100, new Date(2026, 10, 30, 0, 30)), doc(3000, NOV30_LATE), doc(700, DEC1_EARLY)]);
    const report = await getDailyCollectionData({ date: "2026-11-30" });
    expect(report.grandTotal).toBe(3100);
    expect(report.totalRecords).toBe(2);
    expect(report.date).toBe("2026-11-30");
  });

  it("date=Nov1 includes the early-PKT payment the UTC day missed", async () => {
    seed([doc(2000, NOV1_EARLY), doc(500, OCT31_LATE)]);
    const report = await getDailyCollectionData({ date: "2026-11-01" });
    expect(report.grandTotal).toBe(2000);
    expect(report.totalRecords).toBe(1);
  });

  it("no params → today's LOCAL day, labelled with the local date key", async () => {
    seed([]);
    const report = await getDailyCollectionData({});
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    expect(lastFilter.datePaid.$gte).toEqual(start);
    expect(lastFilter.datePaid.$lt).toEqual(end);
    expect(report.date).toBe(todayKey());
  });
});

describe("getDailyCollectionData — validation and unchanged report logic", () => {
  it.each([
    ["bad date", { date: "2026-02-30" }],
    ["bad from", { from: "nope", to: "2026-11-30" }],
    ["bad to", { from: "2026-11-01", to: "2026-13-01" }],
  ])("%s → fail-closed error (controller renders 400)", async (_label, query) => {
    seed([]);
    await expect(getDailyCollectionData(query)).rejects.toThrow(/YYYY-MM-DD/);
    expect(mockFeesFind).not.toHaveBeenCalled();
  });

  it("grouping, per-head totals and response envelope are unchanged", async () => {
    seed(CASE_6000);
    const report = await getDailyCollectionData({ from: "2026-11-01", to: "2026-11-30" });
    expect(Object.keys(report).sort()).toEqual(
      ["byClass", "byHead", "date", "from", "grandTotal", "to", "totalRecords"].sort()
    );
    expect(report.from).toBe("2026-11-01");
    expect(report.to).toBe("2026-11-30");
    expect(report.byHead).toEqual({ Tuition: { count: 3, total: 6000 } });
    expect(report.byClass["5 — Blue"].A.total).toBe(6000);
    expect(report.byClass["5 — Blue"].A.fees).toHaveLength(3);
    expect(report.byClass["5 — Blue"].A.fees[0]).toMatchObject({
      studentName: "Probe Student",
      rollNumber: "1",
      feeHeadName: "Tuition",
      amount: 2000,
    });
  });

  it("only paid rows are counted (pending rows in range are ignored)", async () => {
    const pending = { ...doc(9999, NOV15), status: "pending" };
    seed([...CASE_6000, pending]);
    const report = await getDailyCollectionData({ from: "2026-11-01", to: "2026-11-30" });
    expect(report.grandTotal).toBe(6000);
  });
});