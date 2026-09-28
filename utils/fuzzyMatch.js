function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Normalize a roll number for OCR comparison: "Roll #007", "7", " 7 " and 7
 * all collapse to "7" (case/space stripped, leading zeros removed for pure
 * numerics). Returns "" when nothing usable remains.
 */
function normalizeRoll(roll) {
  const s = String(roll ?? "").toLowerCase().replace(/roll\s*(no\.?|number\.?)?|#|[\s._-]+/g, "").replace(/\b(no\.?|number)\b/g, "");
  if (!s) return "";
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
}

/**
 * Recommend the best student for an OCR row.
 *
 * A roll number read from the sheet is matched FIRST: it is far more
 * discriminating than handwriting-tolerant name similarity (names collide and
 * get misspelled; a roll pins one student in a class). Name-only fuzzy
 * matching remains the fallback whenever no roll was read or it is ambiguous
 * (the same roll shared across parallel sections).
 *
 * @param ocrName  name as read by OCR
 * @param students candidate pool (already scoped, e.g. to the test roster)
 * @param ocrRoll  optional roll number as read by OCR (string or number)
 */
function matchStudent(ocrName, students, ocrRoll) {
  const name = (ocrName || "").toLowerCase().trim();
  if (!students.length) {
    return { studentId: null, matchedName: null, confidence: "low" };
  }

  // ── Roll-first: an exact (normalized) roll hit pins the student ─────────
  const roll = normalizeRoll(ocrRoll);
  if (roll) {
    const rollHits = students.filter((s) => normalizeRoll(s.rollNumber) === roll);
    if (rollHits.length === 1) {
      const best = rollHits[0];
      const dist = levenshtein(name, (best.name || "").toLowerCase().trim());
      const maxLen = Math.max(name.length, (best.name || "").length, 1);
      const similarity = 1 - dist / maxLen;
      // Roll alone identifies the student even when the handwritten name is
      // unreadable; the name corroborates but never vetoes the roll hit.
      const confidence = !name || similarity >= 0.6 ? "high" : "medium";
      return { studentId: best._id, matchedName: best.name, confidence, matchedBy: "roll" };
    }
    // Ambiguous roll (parallel sections share roll numbers) or no hit —
    // fall through to name matching.
  }

  if (!name) {
    return { studentId: null, matchedName: null, confidence: "low" };
  }

  let best = null;
  let bestDist = Infinity;

  for (const s of students) {
    const candidate = (s.name || "").toLowerCase().trim();
    const dist = levenshtein(name, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }

  const maxLen = Math.max(name.length, (best.name || "").length, 1);
  const similarity = 1 - bestDist / maxLen;

  let confidence = "low";
  if (similarity >= 0.85) confidence = "high";
  else if (similarity >= 0.6) confidence = "medium";

  return {
    studentId: best._id,
    matchedName: best.name,
    confidence,
    matchedBy: "name",
  };
}

module.exports = { matchStudent, normalizeRoll };
