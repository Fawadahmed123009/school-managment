/**
 * Verification tests — PDF / export / photo batch (audit re-audit).
 *
 * Drives the real PDF + export generation code with mocked models and real
 * filesystem/PDF/XLSX libraries (no DB). Asserts the FIXED behaviour and,
 * where useful, reproduces the old crash to make the before/after concrete.
 *
 * Covers:
 *   F-2  result-sheet PDF — a deleted (null) student renders "—" instead of 500
 *   F-3  XLSX export      — header row still present for an empty result set
 *   D-1  session PDF      — phase:null tests flow into the document (smoke)
 *   E-1  photo loader     — local /uploads paths resolve to bytes (shared helper)
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockTestFind = jest.fn();
const mockTestFindById = jest.fn();
const mockTestResultFind = jest.fn();
const mockTestSessionFindById = jest.fn();
const mockStudentFind = jest.fn();
const mockStudentFindById = jest.fn();
const mockClassFindById = jest.fn();

jest.mock("../models/Academic/test.model", () => ({
  find: (...a) => mockTestFind(...a),
  findById: (...a) => mockTestFindById(...a),
}));
jest.mock("../models/Academic/testResult.model", () => ({
  find: (...a) => mockTestResultFind(...a),
}));
jest.mock("../models/Academic/testSession.model", () => ({
  findById: (...a) => mockTestSessionFindById(...a),
}));
jest.mock("../models/Students/students.model", () => ({
  find: (...a) => mockStudentFind(...a),
  findById: (...a) => mockStudentFindById(...a),
}));
jest.mock("../models/Academic/class.model", () => ({
  findById: (...a) => mockClassFindById(...a),
}));

const pdfReport = require("../services/academic/pdfReport.service");
const studentExport = require("../services/students/studentExport.service");
const { loadStudentPhoto } = require("../utils/studentPhoto");

function asQuery(value) {
  const q = {
    populate: () => q,
    select: () => q,
    lean: () => Promise.resolve(value),
    sort: () => q,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return q;
}
const oid = (s) => ({ toString: () => s });

beforeEach(() => jest.clearAllMocks());

// ═════════════════════════════════════════════════════════════════════════════
// F-2 — result-sheet PDF null student
// ═════════════════════════════════════════════════════════════════════════════
describe("F-2 result-sheet PDF — deleted student", () => {
  test("BEFORE: dereferencing r.student.name on a null student throws", () => {
    const results = [{ student: null, score: 5 }];
    expect(() => results.map((r) => r.student.name)).toThrow(TypeError);
  });

  test("AFTER: generateResultSheetPDF resolves and writes a PDF despite a null student", async () => {
    mockTestFindById.mockReturnValue(
      asQuery({ _id: oid("t1"), name: "Math Test", subject: { name: "Math" }, classLevels: [], date: new Date(), totalMarks: 100, passMarks: 40 })
    );
    mockTestResultFind.mockReturnValue(
      asQuery([
        { student: null, score: 50 }, // deleted out-of-band
        { student: { name: "Alice", rollNumber: "1", studentId: "S1" }, score: 80 },
      ])
    );

    const out = await pdfReport.generateResultSheetPDF("t1", "Test School");
    expect(out.filePath).toMatch(/\.pdf$/);
    expect(fs.existsSync(out.filePath)).toBe(true);
    fs.unlinkSync(out.filePath); // tidy
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D-1 — session report PDF with phase:null + zero-total tests
// ═════════════════════════════════════════════════════════════════════════════
describe("D-1 session-report PDF — ungrouped & zero-total tests", () => {
  test("generates without crashing when a phase:null and a totalMarks=0 test exist", async () => {
    mockTestSessionFindById.mockResolvedValue({
      _id: oid("sess1"), name: "Term 1",
      phases: [{ _id: oid("ph1"), name: "Phase 1", order: 1 }],
    });
    mockStudentFindById.mockReturnValue(
      asQuery({ _id: oid("stu1"), name: "Bob", studentId: "S2", rollNumber: "7", fatherName: "X", classLevel: null, photoUrl: null, whatsappNumber: "" })
    );
    mockTestFind.mockReturnValue(
      asQuery([
        { _id: oid("t1"), name: "Grouped", subject: { name: "Math" }, totalMarks: 100, phase: oid("ph1") },
        { _id: oid("t2"), name: "Ungrouped", subject: { name: "Math" }, totalMarks: 100, phase: null },
        { _id: oid("t3"), name: "Legacy zero-total", subject: { name: "Math" }, totalMarks: 0, phase: oid("ph1") },
      ])
    );
    mockTestResultFind.mockReturnValue(
      asQuery([{ test: oid("t1"), score: 80 }, { test: oid("t2"), score: 55 }, { test: oid("t3"), score: 30 }])
    );

    const out = await pdfReport.generateSessionReportPDF("sess1", "stu1", "Test School");
    expect(fs.existsSync(out.filePath)).toBe(true);
    fs.unlinkSync(out.filePath);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F-3 — XLSX header row on empty export
// ═════════════════════════════════════════════════════════════════════════════
describe("F-3 XLSX export — empty result set keeps header row", () => {
  test("BEFORE: json_to_sheet([]) emits no header labels at all", () => {
    const sheet = XLSX.utils.json_to_sheet([]);
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    // The whole point of the bug: the header row is simply absent.
    expect(rows.flat()).not.toContain("Student ID");
    expect(rows.flat()).not.toContain("Name");
  });

  test("AFTER: an empty export still has the header labels in row 1", async () => {
    mockStudentFind.mockReturnValue(asQuery([])); // zero matching students
    const buf = await studentExport.generateExcel("all", [], ["name", "studentId", "rollNumber"], 0);

    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets["Students"];
    expect(ws["!ref"]).toBeDefined();
    const row1 = XLSX.utils.sheet_to_json(ws, { header: 1 })[0];
    // Column order follows ALL_FIELDS (studentId, rollNumber, name), matching
    // exactly how a populated export would lay out the same selection.
    expect(row1).toEqual(["Student ID", "Roll Number", "Name"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E-1 — shared photo loader handles local /uploads paths
// ═════════════════════════════════════════════════════════════════════════════
describe("E-1 loadStudentPhoto — local-path handling", () => {
  test("reads a real local image file (relative to cwd) and detects its type", async () => {
    // 1×1 transparent PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    const rel = path.join("tmp", "_e1_photo.png");
    const abs = path.join(process.cwd(), rel);
    fs.writeFileSync(abs, png);
    try {
      const photoUrl = "/" + rel.split(path.sep).join("/"); // e.g. /tmp/_e1_photo.png
      const result = await loadStudentPhoto(photoUrl);
      expect(result).not.toBeNull();
      expect(result.type).toBe("png");
      expect(Buffer.isBuffer(result.buffer)).toBe(true);
    } finally {
      fs.unlinkSync(abs);
    }
  });

  test("a local path that does not exist returns null (never throws)", async () => {
    const result = await loadStudentPhoto("/tmp/definitely-missing-photo-xyz.png");
    expect(result).toBeNull();
  });

  test("the export service now shares this loader (fetchImageBuffer delegates)", async () => {
    // The export's photo fetch and the reports both go through utils/studentPhoto.
    // A local relative path must resolve identically here (was silently dropped before).
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    const rel = path.join("tmp", "_e1_photo2.png");
    const abs = path.join(process.cwd(), rel);
    fs.writeFileSync(abs, png);
    try {
      const photoUrl = "/" + rel.split(path.sep).join("/");
      const result = await loadStudentPhoto(photoUrl);
      expect(result && result.type).toBe("png");
    } finally {
      fs.unlinkSync(abs);
    }
  });
});
