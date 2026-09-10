const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireRole, requireAdminOrManager } = require("../../middlewares/authView");

router.get("/assignments", requireAdminOrManager(), async (req, res) => {
  const search = (req.query.search || "").trim();
  const filterTeacher = req.query.teacher || "";
  const filterSubject = req.query.subject || "";
  const filterClass = req.query.classLevel || "";

  const [assignmentsRes, teachersRes, subjectsRes, classesRes] = await Promise.all([
    apiFetch("/assignments?" + new URLSearchParams({
      ...(req.query.search && { search: req.query.search }),
      ...(req.query.teacher && { teacher: req.query.teacher }),
      ...(req.query.subject && { subject: req.query.subject }),
      ...(req.query.classLevel && { classLevel: req.query.classLevel }),
      ...(req.query.page && { page: req.query.page }),
      ...(req.query.limit && { limit: req.query.limit }),
    }).toString(), req.token),
    apiFetch("/teachers?limit=100", req.token),
    apiFetch("/subject", req.token),
    apiFetch("/class-levels", req.token),
  ]);

  // assignmentsRes.data is now { data: [...], pagination: {...} }
  const assignmentsPayload = assignmentsRes.status === "success" ? assignmentsRes.data : {};
  const assignments = Array.isArray(assignmentsPayload) ? assignmentsPayload : (assignmentsPayload.data || []);
  const pagination = assignmentsPayload.pagination || null;

  const subjects = subjectsRes.status === "success" ? subjectsRes.data : [];
  const classes = classesRes.status === "success" ? classesRes.data : [];

  // Build a lookup: for each subject, which class IDs it applies to
  const subjectClassMap = {};
  const subjectHasAppliesTo = {};
  subjects.forEach((s) => {
    const appliesClassIds = [];
    const hasAppliesTo = s.appliesTo && s.appliesTo.length > 0;
    if (hasAppliesTo) {
      s.appliesTo.forEach((a) => {
        if (a.classLevel) {
          appliesClassIds.push(String(a.classLevel));
        } else if (a.gradeLevel) {
          // Include all classes in that grade
          classes.forEach((c) => {
            const cid = String(c._id);
            if (c.gradeLevel === a.gradeLevel && !appliesClassIds.includes(cid)) {
              appliesClassIds.push(cid);
            }
          });
        }
      });
    }
    // A subject with empty appliesTo correctly gets zero classes — no fallback
    subjectClassMap[s._id] = appliesClassIds;
    subjectHasAppliesTo[s._id] = hasAppliesTo;
  });

  // Group classes by grade for the checkbox list
  const classesByGrade = {};
  classes.forEach((c) => {
    const grade = c.gradeLevel || "Other";
    if (!classesByGrade[grade]) classesByGrade[grade] = [];
    classesByGrade[grade].push(c);
  });
  // Sort grades numerically (PG first, then 1-12)
  const gradeOrder = ["PG", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  const sortedGrades = Object.keys(classesByGrade).sort((a, b) => {
    return gradeOrder.indexOf(a) - gradeOrder.indexOf(b);
  });

  res.render("assignments/list", {
    page: "assignments",
    user: req.user,
    ok: req.query.ok === "1",
    okMsg: req.query.msg || null,
    createError: req.query.error || null,
    assignments,
    pagination,
    teachers: teachersRes.status === "success" ? (Array.isArray(teachersRes.data) ? teachersRes.data : teachersRes.data?.data || []) : [],
    subjects,
    classes,
    classesByGrade,
    sortedGrades,
    subjectClassMap: JSON.stringify(subjectClassMap),
    subjectHasAppliesTo: JSON.stringify(subjectHasAppliesTo),
    filters: { search, teacher: filterTeacher, subject: filterSubject, classLevel: filterClass },
    loadError: assignmentsRes.status === "success" ? null : assignmentsRes.message,
    schoolName: res.locals.schoolName,
  });
});

router.post("/assignments/create", requireAdminOrManager(), async (req, res) => {
  const { teacher, subject, classLevels } = req.body;

  // classLevels comes as an array from checkboxes
  const levels = Array.isArray(classLevels) ? classLevels : classLevels ? [classLevels] : [];

  const result = await apiFetch("/assignments", req.token, {
    method: "POST",
    body: JSON.stringify({ teacher, subject, classLevels: levels }),
  });

  if (result.status !== "success") {
    return res.redirect(`/assignments?error=${encodeURIComponent(result.message)}`);
  }

  // Build a summary message
  const data = result.data;
  let msg = `${data.created} assignment${data.created !== 1 ? 's' : ''} created`;
  if (data.skipped > 0) msg += `, ${data.skipped} duplicate${data.skipped !== 1 ? 's' : ''} skipped`;
  if (data.errors && data.errors.length > 0) msg += `, ${data.errors.length} error${data.errors.length !== 1 ? 's' : ''}`;

  res.redirect(`/assignments?ok=1&msg=${encodeURIComponent(msg)}`);
});

router.post("/assignments/:assignmentId/delete", requireAdminOrManager(), async (req, res) => {
  await apiFetch(`/assignments/${req.params.assignmentId}`, req.token, { method: "DELETE" });
  res.redirect("/assignments?ok=1");
});

module.exports = router;
