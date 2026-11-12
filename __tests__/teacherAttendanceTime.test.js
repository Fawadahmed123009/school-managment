/**
 * Pure time-math tests for teacher attendance (Phase 1):
 * HH:MM validation, working-minutes derivation, and the late flag under the
 * admin grace rule judged against each teacher's own expected arrival time
 * (disabled rule or missing expectation → never late).
 */

const {
  isValidTime,
  timeToMinutes,
  computeWorkingMinutes,
  computeLateFlag,
  formatMinutes,
  hhmmFromDate,
  dayStartFromDate,
} = require("../utils/teacherAttendanceTime");

describe("isValidTime / timeToMinutes", () => {
  it.each(["00:00", "08:05", "12:30", "23:59"])("accepts %s", (t) => {
    expect(isValidTime(t)).toBe(true);
  });

  it.each(["8:05", "24:00", "12:60", "12:5", "1200", "", null, undefined, 800, "12:00:00"])(
    "rejects %p",
    (t) => {
      expect(isValidTime(t)).toBe(false);
    }
  );

  it("converts to minutes since midnight", () => {
    expect(timeToMinutes("00:00")).toBe(0);
    expect(timeToMinutes("08:05")).toBe(485);
    expect(timeToMinutes("23:59")).toBe(1439);
  });
});

describe("computeWorkingMinutes", () => {
  it("derives minutes between arrival and departure", () => {
    expect(computeWorkingMinutes("08:00", "15:30")).toBe(450);
    expect(computeWorkingMinutes("08:05", "08:06")).toBe(1);
  });

  it("returns null when departure is not strictly after arrival", () => {
    expect(computeWorkingMinutes("15:00", "08:00")).toBeNull();
    expect(computeWorkingMinutes("08:00", "08:00")).toBeNull();
  });

  it("returns null for invalid times (never NaN into the store)", () => {
    expect(computeWorkingMinutes("8:00", "15:00")).toBeNull();
    expect(computeWorkingMinutes("08:00", "")).toBeNull();
  });
});

describe("computeLateFlag", () => {
  // Lateness is judged against the teacher's OWN expected arrival time
  // (staff profile) + grace — never against the global settings.startTime.
  const rule = { lateDetectionEnabled: true, startTime: "07:00", graceMinutes: 10 };
  const expected = "08:00";

  it("disabled rule → never late, even for a very late arrival", () => {
    expect(computeLateFlag("12:00", { ...rule, lateDetectionEnabled: false }, expected))
      .toEqual({ isLate: false, lateMinutes: 0 });
  });

  it("missing settings (no doc yet) → never late (default disabled)", () => {
    expect(computeLateFlag("12:00", null, expected)).toEqual({ isLate: false, lateMinutes: 0 });
    expect(computeLateFlag("12:00", undefined, expected)).toEqual({ isLate: false, lateMinutes: 0 });
  });

  it("NO expected arrival time → late detection SKIPPED (no global fallback)", () => {
    // Even a noon arrival under an enabled rule stays unflagged when the
    // teacher's profile has no expected time — false positives avoided.
    expect(computeLateFlag("12:00", rule, "")).toEqual({ isLate: false, lateMinutes: 0 });
    expect(computeLateFlag("12:00", rule, undefined)).toEqual({ isLate: false, lateMinutes: 0 });
    expect(computeLateFlag("12:00", rule, "8am")).toEqual({ isLate: false, lateMinutes: 0 });
  });

  it("arrival before/at expected+grace is on time", () => {
    expect(computeLateFlag("07:55", rule, expected)).toEqual({ isLate: false, lateMinutes: 0 });
    expect(computeLateFlag("08:10", rule, expected)).toEqual({ isLate: false, lateMinutes: 0 }); // exactly at threshold
  });

  it("arrival past expected+grace is late with the overshoot in minutes", () => {
    expect(computeLateFlag("08:11", rule, expected)).toEqual({ isLate: true, lateMinutes: 1 });
    expect(computeLateFlag("08:35", rule, expected)).toEqual({ isLate: true, lateMinutes: 25 });
  });

  it("the per-teacher time, not settings.startTime, sets the threshold", () => {
    // Global start is 07:00 here; with the teacher's own 09:00 expectation
    // an 08:30 arrival is EARLY, not late.
    expect(computeLateFlag("08:30", rule, "09:00")).toEqual({ isLate: false, lateMinutes: 0 });
    expect(computeLateFlag("08:30", rule, "08:00")).toEqual({ isLate: true, lateMinutes: 20 });
  });

  it("zero grace: late strictly after the expected time", () => {
    const strict = { lateDetectionEnabled: true, startTime: "08:00", graceMinutes: 0 };
    expect(computeLateFlag("08:00", strict, expected)).toEqual({ isLate: false, lateMinutes: 0 });
    expect(computeLateFlag("08:01", strict, expected)).toEqual({ isLate: true, lateMinutes: 1 });
  });
});

describe("formatMinutes", () => {
  it("formats durations for display", () => {
    expect(formatMinutes(450)).toBe("7h 30m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(60)).toBe("1h 00m");
  });
});

describe("hhmmFromDate / dayStartFromDate (login/logout capture)", () => {
  it("formats a Date's LOCAL clock as HH:MM to the minute", () => {
    expect(hhmmFromDate(new Date(2026, 10, 12, 8, 5))).toBe("08:05");
    expect(hhmmFromDate(new Date(2026, 10, 12, 0, 0))).toBe("00:00");
    expect(hhmmFromDate(new Date(2026, 10, 12, 23, 59))).toBe("23:59");
  });

  it("buckets a Date to its LOCAL midnight (attendance date convention)", () => {
    const day = dayStartFromDate(new Date(2026, 10, 12, 14, 37, 52, 400));
    expect(day).toEqual(new Date(2026, 10, 12));
    expect(day.getHours()).toBe(0);
    expect(day.getMinutes()).toBe(0);
    expect(day.getSeconds()).toBe(0);
  });
});