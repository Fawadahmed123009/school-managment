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
  // ── Combined-subject mode ───────────────────────────────────────────────
  // Analyse EVERY test of one subject in scope at once (the Subject cascade
  // level left on "All tests"). Pools marks across those tests into combined
  // avg/min/max (percent-normalised) plus a combined marks list. A grade/
  // section pick that matches no class fails closed — the service is skipped
  // and the view shows the empty state instead of an unrestricted query.
  if (viewMode === "combined") {
    const params = new URLSearchParams();
    if (axSubjectId) params.set("subjectId", axSubjectId);
    if (classLevelParam) params.set("classLevelId", classLevelParam);
    if (axStudentId) params.set("studentId", axStudentId);
    if (axSessionId) params.set("sessionId", axSessionId);
    if (sortBy) params.set("sortBy", sortBy);

    // The cascade needs the full catalogue (subjects + tests) even before a
    // subject is chosen; the enhanced snapshot with no testId returns exactly
    // that unfiltered snapshot, so reuse it rather than re-query.
    const [snapshotRes, combinedRes] = await Promise.all([
      apiFetch("/tests/analytics/enhanced", req.token),
      axSubjectId && !gradeSectionEmpty
        ? apiFetch(`/tests/analytics/combined?${params.toString()}`, req.token)
        : Promise.resolve(null),
    ]);

    const snapshot = snapshotRes.status === "success" ? snapshotRes.data : {};
    const tests = snapshot.tests || [];
    const subjects = snapshot.subjects || [];
    const classScope = await buildClassScope(tests);

    const data = combinedRes && combinedRes.status === "success" ? combinedRes.data : {};
    const loadError = combinedRes
      ? combinedRes.status === "success" ? null : combinedRes.message
      : req.query.error || null;

    // Query string the "Download PDF" link carries so the report regenerates the
    // exact same selection (prefixed names match this route's own reading).
    const pdfParams = new URLSearchParams();
    if (axSubjectId) pdfParams.set("axSubjectId", axSubjectId);
    if (axSessionId) pdfParams.set("axSessionId", axSessionId);
    if (axGrade) pdfParams.set("axGrade", axGrade);
    if (axSection) pdfParams.set("axSection", axSection);
    if (axStudentId) pdfParams.set("axStudentId", axStudentId);
    if (sortBy) pdfParams.set("sortBy", sortBy);

    return res.render("tests/analytics", {
      page: "tests-analytics",
      user: req.user,
      viewMode: "combined",
      trendMode: null,
      trendLines: [],
      trendTableRows: [],
      sessions,
      students,
      tests,
      subjects,
      classScope,
      filterState,
      combined: {
        active: !!axSubjectId && !gradeSectionEmpty,
        subject: data.subject || null,
        columns: data.columns || [],
        perTest: data.perTest || [],
        pooled: data.pooled || null,
        distribution: data.distribution || [],
        marksRows: data.marksRows || [],
        resultCount: data.resultCount || 0,
      },
      pdfQuery: pdfParams.toString(),
      current: null,
      previous: null,
      distribution: [],
      resultRows: [],
      resultCount: 0,
      loadError,
      filters: {
        testId: "", classLevelId: gradeSectionEmpty ? "" : classLevelParam,
        subjectId: axSubjectId || "", studentId: axStudentId || "",
        viewMode: "combined", mode: "", sortBy: sortBy || "",
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

router.get("/tests/analytics/pdf", requireAdminOrManager(), async (req, res) => {
  // Server-side download trigger for the Combined-subject view: rebuilds the
  // exact on-screen selection and hands it to the combined-analytics PDF API,
  // then redirects to the opaque UUID URL that serves the file. A GET is used
  // deliberately — it is CSRF-exempt and idempotent from the user's point of
  // view (each click just mints a fresh, short-lived PDF). A grade/section pick
  // that matches no class, or a missing subject, fails closed back to the page.
  const { axSubjectId, axSessionId, axGrade, axSection, axStudentId, sortBy } = req.query;
  if (!axSubjectId) {
    return res.redirect("/tests/analytics?viewMode=combined");
  }
  const { ids: classIds, empty } = await resolveGradeSectionClassIds(axGrade, axSection);
  if (empty) {
    return res.redirect(
      "/tests/analytics?viewMode=combined&error=" + encodeURIComponent("No class matches the selected grade/section")
    );
  }

  const body = {
    subjectId: axSubjectId,
    sessionId: axSessionId || undefined,
    classLevelId: classIds.join(",") || undefined,
    studentId: axStudentId || undefined,
    sortBy: sortBy || undefined,
  };
  const result = await apiFetch("/pdf-reports/analytics-combined", req.token, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (result.status !== "success") {
    return res.redirect(
      "/tests/analytics?viewMode=combined&error=" + encodeURIComponent(result.message || "PDF generation failed")
    );
  }
  return res.redirect(result.data.pdfUrl);
});

module.exports = router;
