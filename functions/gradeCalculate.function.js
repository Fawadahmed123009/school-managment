exports.gradeCalculate = (score, totalMark, passMark) => {
  const grade = totalMark > 0 ? (score / totalMark) * 100 : 0;
  const status = score >= passMark ? "passed" : "failed";

  let letterGrade;
  if (grade >= 80) letterGrade = "A";
  else if (grade >= 70) letterGrade = "B";
  else if (grade >= 60) letterGrade = "C";
  else if (grade >= 50) letterGrade = "D";
  else letterGrade = "F";

  const remarks = letterGrade === "A" ? "Excellent" : letterGrade <= "C" ? "Good" : "Poor";

  return { grade, status, letterGrade, remarks };
};
