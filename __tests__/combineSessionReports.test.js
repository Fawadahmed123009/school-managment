/**
 * combinePdfs — the "Combine as Single PDF" print action.
 *
 * The service reads the individual report PDFs the bulk flow already wrote and
 * stitches their pages into ONE file, in the order the uuids are given. These
 * tests exercise that merge against real PDF bytes (via pdf-lib), with no DB:
 *   • page count + ORDER are preserved (distinct page sizes prove sequence);
 *   • a malformed / traversal uuid is dropped before it reaches the filesystem;
 *   • an empty / all-invalid selection throws rather than emitting a blank PDF.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PDFDocument } = require("pdf-lib");

const service = require("../services/academic/pdfReport.service");
const PDF_DIR = path.join(__dirname, "../tmp/pdfs");

// Write a single-page PDF of a known size to PDF_DIR and return its uuid, so the
// merged output can be checked for BOTH page count and page order.
async function makeSourcePdf(width, height) {
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  const uuid = crypto.randomUUID();
  fs.writeFileSync(path.join(PDF_DIR, `${uuid}.pdf`), await doc.save());
  return uuid;
}

const track = [];
const created = (uuid) => { track.push(uuid); return uuid; };
afterEach(() => {
  track.forEach((u) => {
    fs.rmSync(path.join(PDF_DIR, `${u}.pdf`), { force: true });
    fs.rmSync(path.join(PDF_DIR, `${u}.json`), { force: true });
  });
  track.length = 0;
});

test("merges PDFs in the given order and preserves every page", async () => {
  const a = created(await makeSourcePdf(200, 100));
  const b = created(await makeSourcePdf(300, 150));
  const c = created(await makeSourcePdf(400, 120));

  const result = await service.combinePdfs([a, b, c]);
  created(result.uuid);

  expect(result.fileCount).toBe(3);
  expect(result.pageTotal).toBe(3);

  const merged = await PDFDocument.load(fs.readFileSync(result.filePath));
  const sizes = merged.getPages().map((p) => `${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`);
  expect(sizes).toEqual(["200x100", "300x150", "400x120"]);
});

test("output order follows the submitted uuid order (reversed input → reversed pages)", async () => {
  const a = created(await makeSourcePdf(200, 100));
  const b = created(await makeSourcePdf(300, 150));

  const result = await service.combinePdfs([b, a]);
  created(result.uuid);

  const merged = await PDFDocument.load(fs.readFileSync(result.filePath));
  const widths = merged.getPages().map((p) => Math.round(p.getWidth()));
  expect(widths).toEqual([300, 200]);
});

test("drops malformed / traversal uuids before touching the filesystem", async () => {
  const good = created(await makeSourcePdf(250, 100));
  const good2 = created(await makeSourcePdf(260, 100));

  const result = await service.combinePdfs([
    good,
    "../../etc/passwd",
    "not-a-uuid",
    good2,
  ]);
  created(result.uuid);

  // Only the two real report files survive the UUID-shape filter.
  expect(result.fileCount).toBe(2);
  expect(result.pageTotal).toBe(2);
});

test("writes a download-name sidecar for the combined file", async () => {
  const a = created(await makeSourcePdf(200, 100));
  const b = created(await makeSourcePdf(200, 100));

  const result = await service.combinePdfs([a, b], "Report Cards — Term 1 (combined).pdf");
  created(result.uuid);

  expect(service.getPdfDownloadName(result.uuid)).toBe("Report Cards — Term 1 (combined).pdf");
});

test("throws when nothing valid remains to combine", async () => {
  await expect(service.combinePdfs(["bad", "../../x"])).rejects.toThrow();
  await expect(service.combinePdfs([])).rejects.toThrow();
});
