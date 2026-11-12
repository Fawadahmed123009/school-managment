/**
 * Shared local-day date-range helper (utils/dateRange) unit tests.
 *
 * The helper is the single source of truth for inclusive local-calendar
 * range bounds used by the collections report, the expense history, and
 * future Phase 4 reporting. All expectations use server-local Date
 * constructors so the suite is timezone-independent.
 */

const {
  parseDayStart,
  nextDay,
  todayKey,
  dayRangeFilter,
  singleDayFilter,
} = require("../utils/dateRange");

describe("dayRangeFilter — inclusive local-calendar bounds", () => {
  it("from/to → [from local midnight, to local midnight + 1 day)", () => {
    expect(dayRangeFilter("2026-11-01", "2026-11-30")).toEqual({
      $gte: new Date(2026, 10, 1),
      $lt: new Date(2026, 11, 1),
    });
  });

  it("never emits $lte on a day string (the collections undercount bug)", () => {
    const f = dayRangeFilter("2026-11-01", "2026-11-30");
    expect(f.$lte).toBeUndefined();
  });

  it("rolls over month and year boundaries (Dec 31 → Jan 1 next year)", () => {
    expect(dayRangeFilter("2026-12-01", "2026-12-31")).toEqual({
      $gte: new Date(2026, 11, 1),
      $lt: new Date(2027, 0, 1),
    });
  });

  it("handles leap years (Feb 28 2028 → Feb 29, Feb 29 → Mar 1)", () => {
    expect(dayRangeFilter("2028-02-01", "2028-02-28").$lt).toEqual(new Date(2028, 1, 29));
    expect(dayRangeFilter("2028-02-01", "2028-02-29").$lt).toEqual(new Date(2028, 2, 1));
  });

  it("same from/to is a single inclusive day", () => {
    expect(dayRangeFilter("2026-11-30", "2026-11-30")).toEqual({
      $gte: new Date(2026, 10, 30),
      $lt: new Date(2026, 11, 1),
    });
  });

  it("open-ended sides: from only / to only / neither", () => {
    expect(dayRangeFilter("2026-11-01", undefined)).toEqual({ $gte: new Date(2026, 10, 1) });
    expect(dayRangeFilter(undefined, "2026-11-30")).toEqual({ $lt: new Date(2026, 11, 1) });
    expect(dayRangeFilter(undefined, undefined)).toEqual({});
  });

  it.each([
    ["malformed from", "2026-13-01", "2026-11-30"],
    ["malformed to", "2026-11-01", "not-a-date"],
    ["impossible calendar day", "2026-02-30", "2026-11-30"],
    ["non-string from", 20261101, "2026-11-30"],
  ])("%s → null (caller decides the error response)", (_label, from, to) => {
    expect(dayRangeFilter(from, to)).toBeNull();
  });

  it("from > to is not rejected here — bounds simply match nothing", () => {
    const f = dayRangeFilter("2026-12-01", "2026-11-01");
    expect(f.$gte.getTime()).toBeGreaterThan(f.$lt.getTime());
  });
});

describe("singleDayFilter / todayKey / nextDay", () => {
  it("singleDayFilter(d) === dayRangeFilter(d, d)", () => {
    expect(singleDayFilter("2026-11-30")).toEqual(dayRangeFilter("2026-11-30", "2026-11-30"));
  });

  it("singleDayFilter rejects invalid days", () => {
    expect(singleDayFilter("2026-02-30")).toBeNull();
  });

  it("todayKey is the SERVER-LOCAL day, not the UTC ISO day", () => {
    const n = new Date();
    const expected = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
    expect(todayKey()).toBe(expected);
  });

  it("nextDay crosses month boundaries in local time", () => {
    expect(nextDay(new Date(2026, 10, 30))).toEqual(new Date(2026, 11, 1));
  });

  it("parseDayStart is re-exported and stays fail-closed", () => {
    expect(parseDayStart("2026-11-01")).toEqual(new Date(2026, 10, 1));
    expect(parseDayStart("2026-02-30")).toBeNull();
  });
});