const express = require("express");
const router = express.Router();
const { apiFetch } = require("../../utils/apiClient");
const { requireAdminOrManager } = require("../../middlewares/authView");
const ClassLevel = require("../../models/Academic/class.model");

// ── Cascade grade + section → ClassLevel ids ─────────────────────────────────
// The unified filter cascade (views/reports/partials/filter-cascade.ejs, same
// one the PDF Reports page uses) posts sessionId/grade/section/studentId/
// subjectId/testId. The analytics services keep their internal classLevelId
// query shape, so the view route translates the pupil-funnel picks here — the
// section resolves exactly like every other report cascade (sectionRef name
// preferred, legacy `section` fallback for pre-migration rows).
// Returns { ids, empty }: empty === true means the caller picked a grade
// and/or section that matches NO class — callers must fail closed rather than
// fall back to an unrestricted query (that combination can't be produced by
// the cascade itself, its options are generated from real data).
async function resolveGradeSectionClassIds(grade, section) {
  if (!grade && !section) return { ids: [], empty: false };
  const classes = await ClassLevel.find(grade ? { gradeLevel: grade } : {})
    .select("gradeLevel section sectionRef")
    .populate("sectionRef", "name")
    .lean();
  const matched = section
    ? classes.filter((c) => ((c.sectionRef && c.sectionRef.name) || c.section || null) === section)
    : classes;
  const ids = matched.map((c) => String(c._id));
  return { ids, empty: ids.length === 0 };
}

// classLevelId → { grade, section } map the shared cascade JS reads from the
// #report-class-scope island (same shape as views/reports/generate.ejs). Built
// from the cascade's test list, mirroring the PDF Reports page.
async function buildClassScope(tests) {
  const referenced = new Set();
  (tests || []).forEach((t) =>
    (t.classLevels || []).forEach((cl) => {
      const id = cl && cl._id ? String(cl._id) : cl ? String(cl) : null;
      if (id) referenced.add(id);
    })
  );
  const scope = {};
  if (referenced.size === 0) return scope;
  const classes = await ClassLevel.find({ _id: { $in: [...referenced] } })
    .select("gradeLevel section sectionRef")
    .populate("sectionRef", "name")
    .lean();
  classes.forEach((c) => {
    scope[String(c._id)] = {
      grade: c.gradeLevel || null,
      section: (c.sectionRef && c.sectionRef.name) || c.section || null,
    };
  });
  return scope;
}

router.get("/tests/analytics", requireAdminOrManager(), async (req, res) => {
  // The cascade submits under `ax*`-prefixed names (fresh prefix, so the shared
  // partial's markup/JS never has to know which page hosts it). sortBy stays
  // unprefixed — it's the page's own Sort control, not a cascade level.
  const {
    axTestId, axSubjectId, axStudentId, axSessionId, axGrade, axSection,
    viewMode, mode, sortBy,
  } = req.query;

  // Admin/manager-scoped cascade options, identical sourcing to the PDF Reports
  // page: unrestricted session list + whole roster of pupils.
  const [sessionsRes, studentsRes] = await Promise.all([
    apiFetch("/test-sessions", req.token),
    apiFetch("/pdf-reports/teacher-students", req.token),
  ]);
  const sessions = sessionsRes.status === "success" ? sessionsRes.data : [];
  const students = studentsRes.status === "success" ? studentsRes.data.students || [] : [];

  // Just-applied selection, embedded as #ax-filter-state so the cascade comes
  // back pre-narrowed after this self-submitting GET form reloads (public/js/
  // tests-analytics-cascade.js feeds it to the shared cascade factory).
  const filterState = {
    sessionId: axSessionId || "",
    grade: axGrade || "",
    section: axSection || "",
    studentId: axStudentId || "",
    subjectId: axSubjectId || "",
    testId: axTestId || "",
  };

  const { ids: classIds, empty: gradeSectionEmpty } = await resolveGradeSectionClassIds(axGrade, axSection);
  const classLevelParam = classIds.join(",");

  // ── Trend mode ──────────────────────────────────────────────────────────
  if (viewMode === "trend") {
    const params = new URLSearchParams();
    params.set("mode", mode || "");
    if (axStudentId) params.set("studentId", axStudentId);
    if (classLevelParam) params.set("classLevelId", classLevelParam);
    if (axSubjectId) params.set("subjectId", axSubjectId);
    if (axSessionId) params.set("sessionId", axSessionId);

    // The trend service returns chart data + its dropdown snapshot; the
    // cascade additionally needs the FULL test list, fetched the same way the
    // PDF Reports page fetches it for admin/manager. A grade/section pick that
    // matches no class fails closed: the service is not called at all (an
    // empty classLevelId would mean "no restriction"), and the view renders
    // the "no trend data" empty state.
    const [trendRes, testsRes] = await Promise.all([
      gradeSectionEmpty
        ? Promise.resolve(null)
        : apiFetch(`/tests/analytics/trend?${params.toString()}`, req.token),
      apiFetch("/tests", req.token),
    ]);
    const data = trendRes && trendRes.status === "success" ? trendRes.data : {};
    const loadError = trendRes ? (trendRes.status === "success" ? null : trendRes.message) : null;
    const tests = testsRes.status === "success" ? testsRes.data : [];
    const classScope = await buildClassScope(tests);

    return res.render("tests/analytics", {
      page: "tests-analytics",
      user: req.user,
      viewMode: "trend",
      trendMode: data.mode || mode || null,
      trendLines: data.trend || [],
      trendTableRows: data.tableRows || [],
      sessions,
      students,
      tests,
      subjects: data.subjects || [],
      classScope,
      filterState,
      current: null,
      previous: null,
      distribution: [],
      resultRows: [],
      resultCount: 0,
      loadError,
      filters: {
        testId: "", classLevelId: gradeSectionEmpty ? "" : classLevelParam,
        subjectId: axSubjectId || "", studentId: axStudentId || "",
        viewMode: "trend", mode: mode || "", sortBy: "",
      },
      hasFilters: false,
      schoolName: res.locals.schoolName,
    });
  }
  // ── Single-test mode (default) ──────────────────────────────────────────
  // Results need a Test; everything above it in the cascade either narrows the
  // result set (grade/section → classLevelId, student → studentId) or only
  // drives the picker (session/subject — the chosen test already pins both).
  // A grade/section pick that matches no class fails closed: the service is
  // called without a testId (pure cascade snapshot) and the view renders the
  // "no results" empty state instead of an unrestricted query.
  const params = new URLSearchParams();
  if (axTestId) params.set("testId", axTestId);
  if (classLevelParam) params.set("classLevelId", classLevelParam);
  if (axStudentId) params.set("studentId", axStudentId);
  if (sortBy) params.set("sortBy", sortBy);

  const hasFilters = !!axTestId;

  const analyticsRes = axTestId && !gradeSectionEmpty
    ? await apiFetch(`/tests/analytics/enhanced?${params.toString()}`, req.token)
    : await apiFetch("/tests/analytics/enhanced", req.token);

  const data = analyticsRes.status === "success" ? analyticsRes.data : {};
  // Unfiltered cascade snapshot from the service (full test catalogue with
  // session/subject/classLevels populated — never pre-narrowed server-side).
  const tests = data.tests || [];
  const classScope = await buildClassScope(tests);

  res.render("tests/analytics", {
    page: "tests-analytics",
    user: req.user,
    viewMode: "single",
    trendMode: null,
    trendLines: [],
    trendTableRows: [],
    sessions,
    students,
    tests,
    subjects: data.subjects || [],
    classScope,
    filterState,
    current: data.current || null,
    previous: data.previous || null,
    distribution: data.distribution || [],
    resultRows: data.resultRows || [],
    resultCount: data.resultCount || 0,
    loadError: analyticsRes.status === "success" ? null : analyticsRes.message,
    filters: {
      testId: axTestId || "", classLevelId: classLevelParam,
      subjectId: axSubjectId || "", studentId: axStudentId || "",
      viewMode: "single", mode: "", sortBy: sortBy || "",
    },
    hasFilters,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;
