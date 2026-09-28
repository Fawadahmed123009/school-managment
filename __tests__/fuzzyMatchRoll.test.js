/**
 * OCR student recommendation with roll number + name (utils/fuzzyMatch.js).
 *
 * Both OCR flows (fee sheet + marks sheet) now extract a "rollNo" per row and
 * pass it to matchStudent. The roll is the stronger signal — sheets are
 * class/section scoped where roll numbers are unique — but it must never
 * fire on a partial pool miss or on an ambiguous roll (parallel sections),
 * and must keep working when the sheet has no roll column at all.
 */

const { matchStudent, normalizeRoll } = require("../utils/fuzzyMatch");

const POOL = [
  { _id: "s1", name: "Muhammad Ali", rollNumber: "7" },
  { _id: "s2", name: "Ayesha Khan", rollNumber: "0012" },
  { _id: "s3", name: "Ayesha Noor", rollNumber: "31" },
];

describe("normalizeRoll", () => {
  test("strips labels, padding and formatting", () => {
    expect(normalizeRoll("Roll #007")).toBe("7");
    expect(normalizeRoll("roll no. 12")).toBe("12");
    expect(normalizeRoll(" 7 ")).toBe("7");
    expect(normalizeRoll(7)).toBe("7");
    expect(normalizeRoll("0012")).toBe("12");
  });

  test("empty-ish inputs yield no roll", () => {
    expect(normalizeRoll(null)).toBe("");
    expect(normalizeRoll(undefined)).toBe("");
    expect(normalizeRoll("")).toBe("");
  });
});

describe("matchStudent — roll + name selection", () => {
  test("a matching roll pins the student even when the name is badly garbled", () => {
    const m = matchStudent("Aysha Kan", POOL, "12");
    expect(m.studentId).toBe("s2");
    expect(m.confidence).toBe("high");
    expect(m.matchedBy).toBe("roll");
  });

  test("roll padding/format differences still match (0012 vs Roll #0012)", () => {
    const m = matchStudent("Ayesha Khan", POOL, "Roll #0012");
    expect(m.studentId).toBe("s2");
    expect(m.confidence).toBe("high");
  });

  test("unreadable name + roll hit is still an actionable recommendation", () => {
    const m = matchStudent("", POOL, "7");
    expect(m.studentId).toBe("s1");
    expect(m.confidence).toBe("high");
  });

  test("roll hit with a contradicting readable name downgrades to medium", () => {
    // Roll says s1, but the name clearly points elsewhere — flag for review.
    const m = matchStudent("Bilal Ahmed Sheikh", POOL, "7");
    expect(m.studentId).toBe("s1");
    expect(m.confidence).toBe("medium");
  });

  test("falls back to name matching when no roll was read", () => {
    const m = matchStudent("Muhammad Ally", POOL, null);
    expect(m.studentId).toBe("s1");
    expect(m.matchedBy).toBe("name");
  });

  test("falls back to name matching when the roll matches nobody in the pool", () => {
    const m = matchStudent("Ayesha Khaan", POOL, "999");
    expect(m.studentId).toBe("s2");
    expect(m.matchedBy).toBe("name");
  });

  test("ambiguous roll (two students share it) does not produce a roll pick", () => {
    const pool = [
      { _id: "a", name: "Ali One", rollNumber: "5" },
      { _id: "b", name: "Ali Two", rollNumber: "5" },
    ];
    const m = matchStudent("Ali Too", pool, "5");
    expect(m.matchedBy).toBe("name");
    expect(m.studentId).toBe("b");
  });

  test("empty pool returns no match", () => {
    const m = matchStudent("Anyone", [], "3");
    expect(m.studentId).toBeNull();
    expect(m.confidence).toBe("low");
  });

  test("no name and no roll yields no match (was the old early-return)", () => {
    const m = matchStudent("", POOL, undefined);
    expect(m.studentId).toBeNull();
    expect(m.confidence).toBe("low");
  });
});
