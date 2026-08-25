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

function matchStudent(ocrName, students) {
  const name = (ocrName || "").toLowerCase().trim();
  if (!name || !students.length) {
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
  };
}

module.exports = { matchStudent };
