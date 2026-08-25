const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole } = require("../../middlewares/authView");

// Old marks entry page — superseded by the Test system (/tests/manage).
// Redirect teachers to the new flow instead of showing a broken page.
router.get("/marks", requireRole("teacher"), (req, res) => {
  res.redirect("/tests/manage");
});

router.post("/marks/create", requireRole("teacher"), async (req, res) => {
  const { student, exam, score } = req.body;
  await apiFetch("/marks", req.token, {
    method: "POST",
    body: JSON.stringify({ student, exam, score: Number(score) }),
  });
  res.redirect("/tests/manage");
});

router.get("/marks/report/:studentId/:academicTermId", requireRole("teacher"), async (req, res) => {
  const { studentId, academicTermId } = req.params;
  const result = await apiFetch(`/marks/student/${studentId}/term/${academicTermId}`, req.token);

  if (result.status !== "success") {
    return res.render("marks/report", {
      page: "marks",
      user: req.user,
      report: null,
      loadError: result.message,
      schoolName: res.locals.schoolName,
    });
  }

  const studentsRes = await apiFetch("/admin/students", req.token);
  const students = studentsRes.status === "success" ? (Array.isArray(studentsRes.data) ? studentsRes.data : studentsRes.data?.data || []) : [];
  const student = students.find((s) => s._id === studentId);

  const report = {
    studentName: student ? student.name : "Student",
    average: result.data.average,
    letterGrade: result.data.overallLetterGrade,
    subjects: result.data.subjects.map((s) => ({
      subject: s.subject && s.subject.name ? s.subject.name : "—",
      score: s.score,
      letterGrade: s.letterGrade,
    })),
  };

  res.render("marks/report", {
    page: "marks",
    user: req.user,
    report,
    loadError: null,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
