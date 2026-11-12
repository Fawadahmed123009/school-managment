/**
 * Batch 1 (High-severity) UI-feedback route fixes — the server half of the
 * toast/inline-validation sweep. Every failure path below used to redirect
 * WITHOUT a message (or crash), so the user saw a silent no-op or a false
 * "Saved." banner. These tests load the REAL view routers with mocked
 * dependencies (same pattern as ocrMarksRosterScope.test.js) and assert:
 *
 *   H2  assignments delete checks the API result (no false ?ok=1) and the
 *       list page surfaces ?error= (rendered via createError).
 *   H1  attendance mark GET passes ?error= through; POST with malformed
 *       records bounces back with a friendly message instead of throwing.
 *   H3  promotion GET passes ?error= through; empty preview/confirm payloads
 *       redirect WITH an explanation instead of silently doing nothing.
 *   H8  families list passes ?error= through on BOTH render paths.
 *   H4  PDF generate GET hands req.query to the template (it reads query.error).
 *   +   /tests/mark surfaces ?ok=1 (the OCR save success flash).
 *
 * UI/feedback-layer only — no validation or business rule is changed.
 */

const mockApiFetch = jest.fn();
jest.mock("../utils/apiClient", () => ({
  apiFetch: (...args) => mockApiFetch(...args),
}));

jest.mock("../middlewares/authView", () => ({
  requireRole: () => (req, res, next) => next(),
  requireAdminOrManager: () => (req, res, next) => next(),
}));

jest.mock("../middlewares/isAssignedToSubject", () => ({
  isAssignedToTestView: (req, res, next) => next(),
}));

const mockGetAllClasses = jest.fn();
jest.mock("../services/academic/class.service", () => ({
  getAllClassesService: (...args) => mockGetAllClasses(...args),
}));

const mockBuildPreview = jest.fn();
const mockExecutePromotion = jest.fn();
jest.mock("../services/students/promotion.service", () => ({
  buildPromotionPreview: (...args) => mockBuildPreview(...args),
  executePromotion: (...args) => mockExecutePromotion(...args),
}));

const mockStudentFind = jest.fn();
jest.mock("../models/Students/students.model", () => ({
  find: (...args) => mockStudentFind(...args),
  findById: jest.fn(),
}));

const mockClassFind = jest.fn();
jest.mock("../models/Academic/class.model", () => ({
  find: (...args) => mockClassFind(...args),
}));

jest.mock("../models/Parents/parents.model", () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

const mockPaginate = jest.fn();
jest.mock("../utils/paginate", () => ({
  paginate: (...args) => mockPaginate(...args),
}));

jest.mock("../services/academic/pdfReport.service", () => ({
  getPdfPath: jest.fn(),
  getPdfDownloadName: jest.fn(),
  combinePdfs: jest.fn(),
}));

jest.mock("../utils/testCategoryIndex", () => ({
  buildSessionIndex: jest.fn().mockResolvedValue({ sessionRank: {}, phaseOrder: {} }),
  sortTestsByCategory: jest.fn(),
}));

jest.mock("../models/Academic/testSession.model", () => ({ findById: jest.fn() }));
jest.mock("../models/Academic/week.model", () => ({ find: jest.fn() }));

const assignmentsRouter = require("../routes/views/assignments.views");
const attendanceRouter = require("../routes/views/attendance.views");
const promotionRouter = require("../routes/views/promotion.views");
const familiesRouter = require("../routes/views/families.views");
const { generateRouter } = require("../routes/views/pdfReport.views");
const testTeacherRouter = require("../routes/views/testTeacher.views");

// ── helpers ──────────────────────────────────────────────────────────────────

function handler(router, path, method) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  return {
    render: jest.fn(),
    redirect: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    send: jest.fn(),
    setHeader: jest.fn(),
    locals: { schoolName: "Test School" },
  };
}

function makeReq(overrides = {}) {
  return Object.assign(
    { user: { _id: "u1", role: "admin" }, token: "tok", query: {}, params: {}, body: {} },
    overrides
  );
}

// Chainable lean() query stub (real Mongoose queries chain in any order).
const leanQuery = (docs) => {
  const q = {
    select: () => q,
    populate: () => q,
    sort: () => q,
    lean: async () => docs,
  };
  return q;
};

const redirectUrl = (res) => res.redirect.mock.calls[0][0];
const renderVars = (res) => res.render.mock.calls[0][1];
const errorParam = (url) => decodeURIComponent(url.split("error=")[1] || "");

beforeEach(() => {
  jest.clearAllMocks();
  mockApiFetch.mockImplementation(async () => ({ status: "success", data: [] }));
  mockGetAllClasses.mockResolvedValue([]);
  mockPaginate.mockResolvedValue({ data: [], pagination: null });
  mockStudentFind.mockReturnValue(leanQuery([]));
  mockClassFind.mockReturnValue(leanQuery([]));
});

// ── H2: assignment delete must not report false success ─────────────────────

describe("H2 — assignments delete result is checked", () => {
  const del = () => handler(assignmentsRouter, "/assignments/:assignmentId/delete", "post");

  test("API failure redirects with ?error= (never ?ok=1)", async () => {
    mockApiFetch.mockResolvedValue({ status: "failed", message: "Assignment has linked tests" });
    const res = makeRes();
    await del()(makeReq({ params: { assignmentId: "a1" } }), res);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const url = redirectUrl(res);
    expect(url).toContain("/assignments?error=");
    expect(url).not.toContain("ok=1");
    expect(errorParam(url)).toBe("Assignment has linked tests");
  });

  test("API failure without a message still explains the failure", async () => {
    mockApiFetch.mockResolvedValue({ status: "failed" });
    const res = makeRes();
    await del()(makeReq({ params: { assignmentId: "a1" } }), res);
    expect(errorParam(redirectUrl(res))).toMatch(/could not delete/i);
  });

  test("API success redirects ?ok=1", async () => {
    mockApiFetch.mockResolvedValue({ status: "success" });
    const res = makeRes();
    await del()(makeReq({ params: { assignmentId: "a1" } }), res);
    expect(redirectUrl(res)).toBe("/assignments?ok=1");
  });

  test("list page surfaces ?error= so the delete failure is visible", async () => {
    const res = makeRes();
    await handler(assignmentsRouter, "/assignments", "get")(
      makeReq({ query: { error: "Assignment has linked tests" } }), res
    );
    expect(res.render).toHaveBeenCalledWith("assignments/list", expect.objectContaining({
      createError: "Assignment has linked tests",
    }));
  });
});

// ── H1: attendance error passthrough + malformed-records guard ──────────────

describe("H1 — attendance mark feedback", () => {
  test("GET passes ?error= through to the template", async () => {
    const res = makeRes();
    await handler(attendanceRouter, "/attendance/mark/:classLevelId", "get")(
      makeReq({ params: { classLevelId: "c1" }, query: { date: "2026-11-12", error: "Could not save attendance" } }), res
    );
    expect(renderVars(res).error).toBe("Could not save attendance");
  });

  test("POST with malformed records bounces back with a friendly error, no API call", async () => {
    const res = makeRes();
    await handler(attendanceRouter, "/attendance/mark/:classLevelId", "post")(
      makeReq({ params: { classLevelId: "c1" }, body: { date: "2026-11-12", records: "{not-json" } }), res
    );
    expect(mockApiFetch).not.toHaveBeenCalled();
    const url = redirectUrl(res);
    expect(url).toContain("/attendance/mark/c1?date=2026-11-12&error=");
    expect(errorParam(url)).toMatch(/could not read the attendance entries/i);
  });

  test("POST with missing records also bounces back (JSON.parse(undefined) throws)", async () => {
    const res = makeRes();
    await handler(attendanceRouter, "/attendance/mark/:classLevelId", "post")(
      makeReq({ params: { classLevelId: "c1" }, body: { date: "2026-11-12" } }), res
    );
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(errorParam(redirectUrl(res))).toMatch(/could not read/i);
  });

  test("POST API failure redirects with the server message", async () => {
    mockApiFetch.mockResolvedValue({ status: "failed", message: "Class is inactive" });
    const res = makeRes();
    await handler(attendanceRouter, "/attendance/mark/:classLevelId", "post")(
      makeReq({ params: { classLevelId: "c1" }, body: { date: "2026-11-12", records: "[]" } }), res
    );
    expect(errorParam(redirectUrl(res))).toBe("Class is inactive");
  });

  test("POST success redirects ?ok=1", async () => {
    const res = makeRes();
    await handler(attendanceRouter, "/attendance/mark/:classLevelId", "post")(
      makeReq({ params: { classLevelId: "c1" }, body: { date: "2026-11-12", records: "[]" } }), res
    );
    expect(redirectUrl(res)).toBe("/attendance/mark/c1?date=2026-11-12&ok=1");
  });
});

// ── H3: promotion error passthrough + non-silent empty paths ────────────────

describe("H3 — promotion feedback", () => {
  test("GET passes ?error= through to the picker", async () => {
    const res = makeRes();
    await handler(promotionRouter, "/students/promote", "get")(
      makeReq({ query: { error: "Nothing to apply" } }), res
    );
    expect(renderVars(res).error).toBe("Nothing to apply");
  });

  test("GET error survives the load-failure render path too", async () => {
    mockGetAllClasses.mockRejectedValue(new Error("db down"));
    const res = makeRes();
    await handler(promotionRouter, "/students/promote", "get")(
      makeReq({ query: { error: "boom" } }), res
    );
    const vars = renderVars(res);
    expect(vars.error).toBe("boom");
    expect(vars.loadError).toBe("db down");
  });

  test("preview with no promotion choices redirects WITH an explanation", async () => {
    const res = makeRes();
    await handler(promotionRouter, "/students/promote/preview", "post")(
      makeReq({ body: { sourceClassId: "c1", promotions: "[]" } }), res
    );
    const url = redirectUrl(res);
    expect(url).toContain("/students/promote?sourceClass=c1&error=");
    expect(errorParam(url)).toMatch(/no promotion choices/i);
  });

  test("preview whose students all vanished redirects WITH an explanation", async () => {
    const res = makeRes();
    await handler(promotionRouter, "/students/promote/preview", "post")(
      makeReq({ body: { sourceClassId: "c1", promotions: JSON.stringify([{ studentId: "ghost", action: "graduate" }]) } }), res
    );
    expect(errorParam(redirectUrl(res))).toMatch(/none of the selected students/i);
  });

  test("confirm with an empty list redirects WITH an explanation", async () => {
    const res = makeRes();
    await handler(promotionRouter, "/students/promote/confirm", "post")(
      makeReq({ body: { promotions: "not-json" } }), res
    );
    expect(mockExecutePromotion).not.toHaveBeenCalled();
    expect(errorParam(redirectUrl(res))).toMatch(/nothing to apply/i);
  });

  test("confirm success still reports the promoted count", async () => {
    mockExecutePromotion.mockResolvedValue({ successCount: 2, failCount: 0, failures: [] });
    const res = makeRes();
    await handler(promotionRouter, "/students/promote/confirm", "post")(
      makeReq({ body: { promotions: JSON.stringify([{ studentId: "s1", action: "graduate" }]) } }), res
    );
    const url = redirectUrl(res);
    expect(url).toContain("ok=1");
    expect(decodeURIComponent(url)).toContain("2 student(s) promoted successfully.");
  });
});

// ── H8: families list error passthrough (both render paths) ─────────────────

describe("H8 — families list surfaces ?error=", () => {
  test("success render passes ?error= through", async () => {
    const res = makeRes();
    await handler(familiesRouter, "/families", "get")(
      makeReq({ query: { error: "Family not found" } }), res
    );
    expect(renderVars(res).error).toBe("Family not found");
  });

  test("load-failure render passes ?error= through as well", async () => {
    mockPaginate.mockRejectedValue(new Error("db down"));
    const res = makeRes();
    await handler(familiesRouter, "/families", "get")(
      makeReq({ query: { error: "Family not found" } }), res
    );
    const vars = renderVars(res);
    expect(vars.error).toBe("Family not found");
    expect(vars.loadError).toBe("db down");
  });
});

// ── H4: PDF generate form receives the query (template reads query.error) ───

describe("H4 — PDF generate failure messages reach the form", () => {
  test("GET hands req.query (including ?error=) to the template", async () => {
    const res = makeRes();
    const query = { error: "PDF generation failed" };
    await handler(generateRouter, "/reports/generate", "get")(makeReq({ query }), res);
    expect(res.render).toHaveBeenCalledWith("reports/generate", expect.objectContaining({ query }));
    expect(renderVars(res).query.error).toBe("PDF generation failed");
  });

  test("POST failure redirect target carries the message the GET now renders", async () => {
    mockApiFetch.mockResolvedValue({ status: "failed", message: "No marks for this test" });
    const res = makeRes();
    await handler(generateRouter, "/reports/generate", "post")(
      makeReq({ body: { reportType: "result-sheet", resultSheetTestId: "t1" } }), res
    );
    const url = redirectUrl(res);
    expect(url).toContain("/reports/generate?error=");
    expect(errorParam(url)).toBe("No marks for this test");
  });
});

// ── OCR marks save success flash (/tests/mark?ok=1) ─────────────────────────

describe("OCR save flash — /tests/mark surfaces ?ok=1", () => {
  test("ok=1 renders the success flash variable", async () => {
    const res = makeRes();
    await handler(testTeacherRouter, "/tests/mark", "get")(makeReq({ query: { ok: "1" } }), res);
    expect(renderVars(res).ok).toBe(true);
  });

  test("without ok=1 no flash is shown", async () => {
    const res = makeRes();
    await handler(testTeacherRouter, "/tests/mark", "get")(makeReq(), res);
    expect(renderVars(res).ok).toBe(false);
  });
});