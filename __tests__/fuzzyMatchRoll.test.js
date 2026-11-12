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

// ── Name-match safety guards (marks-disappearing incident) ─────────────────
// A misread handwritten name must NEVER silently bind marks to the wrong
// pupil: weak matches and genuine ties come back UNRESOLVED so the review
// screen forces a manual selection. The roll-first path is deliberately not
// weakened — a unique roll still pins the student even against a garbled name.
describe("matchStudent — name-match confidence floor & ambiguity guard", () => {
  test("a weak (low-confidence) name match resolves to NO student", () => {
    // Reproduction of the incident: "Abiha Atif" is closest to "Ayesha Khan"
    // in this pool but nowhere near enough — the old code bound it anyway.
    const m = matchStudent("Abiha Atif", POOL, null);
    expect(m.studentId).toBeNull();
    expect(m.confidence).toBe("low");
    expect(m.matchedBy).toBe("name");
  });

  test("an exact-name tie between two candidates stays unresolved", () => {
    const pool = [
      { _id: "t1", name: "Ayesha Khan", rollNumber: "1" },
      { _id: "t2", name: "Ayesha Khan", rollNumber: "2" },
    ];
    const m = matchStudent("Ayesha Khan", pool, null);
    expect(m.studentId).toBeNull();
  });

  test("two candidates one edit apart from the OCR name are ambiguous — no pick", () => {
    const pool = [
      { _id: "n1", name: "Ali Ton", rollNumber: "8" },
      { _id: "n2", name: "Ali Toe", rollNumber: "9" },
    ];
    const m = matchStudent("Ali Toa", pool, null); // dist 1 to both
    expect(m.studentId).toBeNull();
  });

  test("a clear winner (exact vs one-edit runner-up) still matches", () => {
    const pool = [
      { _id: "z1", name: "Zunair", rollNumber: "12" },
      { _id: "z2", name: "Zunaira", rollNumber: "17" },
    ];
    const m = matchStudent("Zunair", pool, null);
    expect(m.studentId).toBe("z1");
    expect(m.confidence).toBe("high");
  });

  test("the guards never override a unique roll hit", () => {
    const m = matchStudent("Totally Different Name", POOL, "7");
    expect(m.studentId).toBe("s1");
    expect(m.matchedBy).toBe("roll");
  });
});
