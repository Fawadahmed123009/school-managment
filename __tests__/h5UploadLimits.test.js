/**
 * H5 — upload hardening (utils/uploadFactory.js and its call sites).
 *
 * The finding: every OCR / Excel-import route built its own
 * `multer({ dest: "uploads/" })` — no size cap, no type filter, no file-count
 * cap — so any authenticated-enough client could stream unbounded bodies onto
 * the disk that also holds the DB. And the temp file was unlinked only where
 * the happy path happened to reach that `fs.unlink` line: an over-type reject,
 * an early `return` on bad OCR JSON, or a thrown parse left the blob behind.
 *
 * Locked behaviors:
 *   • the presets carry the limits (8 MB image / 10 MB sheet, one file) and a
 *     type filter that accepts real image/spreadsheet parts (plus the
 *     extension fallback browsers actually send) and refuses everything else;
 *   • an oversized body is refused (413 via the global error handler) and no
 *     partial file survives on disk;
 *   • a rejected type never reaches the temp dir;
 *   • the temp file is removed however the request ends — success, route
 *     `catch`, synchronous throw, rejected async handler (H4) — not just the
 *     happy path;
 *   • cleanup only ever touches files inside uploads/;
 *   • the orphan sweep removes stale extensionless blobs and leaves real
 *     assets, extensioned files and subdirectories alone;
 *   • the OCR/import services unlink on their early-return and throwing paths;
 *   • no route configures multer by hand any more, and every temp-upload route
 *     mounts the cleanup middleware.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { execSync } = require("child_process");

const {
  UPLOAD_DIR,
  PRESETS,
  PHOTO_MAX_BYTES,
  makeUpload,
  createFileFilter,
  cleanupUploadedFiles,
  removeUploadedFile,
  isUploadTempPath,
  sweepOrphanUploads,
} = require("../utils/uploadFactory");
const errorHandler = require("../middlewares/errorHandler");
const installAsyncErrorBoundary = require("../handlers/asyncErrorBoundary.handler");

const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 1×1 PNG — a real image payload, so the "accepted" cases exercise the same
// bytes a browser would send.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

// ── temp files in the REAL uploads/ dir ──────────────────────────────────────
// The factory's cleanup guard is "only unlink things inside uploads/", so the
// tests have to use that same directory for anything expected to be removed.
// Names are unique and every helper deletes what it made.
const madeFiles = [];
const makeOversizeTargets = [];

function makeUploadTempFile(contents = PNG_1PX, name = `h5-${Date.now()}-${Math.random().toString(36).slice(2)}`) {
  const target = path.join(process.cwd(), UPLOAD_DIR, name);
  fs.writeFileSync(target, contents);
  madeFiles.push(target);
  return target;
}

async function fileGone(target, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(target)) return true;
    await sleep(25);
  }
  return !fs.existsSync(target);
}

function snapshotDir(dir = path.join(process.cwd(), UPLOAD_DIR)) {
  return new Set(fs.readdirSync(dir));
}

// A throwaway directory for the sweep tests — never the real uploads/.
let scratch;
beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "h5-upload-"));
});
afterAll(async () => {
  for (const f of madeFiles) {
    try {
      fs.unlinkSync(f);
    } catch (_) {
      /* already removed by the code under test */
    }
  }
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch (_) {
    /* os temp */
  }
});

// ── a minimal app that looks like the upload routes ──────────────────────────
// Real HTTP, real multer, real disk, plus the production error handler so the
// MulterError mapping is part of what is asserted. The H4 boundary is installed
// so a rejected async handler is also covered.
function buildApp(handler) {
  const app = express();
  const upload = makeUpload("image");
  app.post("/up", upload.single("image"), cleanupUploadedFiles, handler);
  app.post("/up-nocleanup", makeUpload("image").single("image"), handler);
  installAsyncErrorBoundary(app);
  app.use(errorHandler);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((r) => server.close(r)),
        post: (p, form) =>
          fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: form }).then(async (res) => ({
            status: res.status,
            body: await res.text(),
          })),
      });
    });
  });
}

const formWith = (blob, name = "blob.png", field = "image") => {
  const form = new FormData();
  form.append(field, blob, name);
  return form;
};

// ── preset configuration ─────────────────────────────────────────────────────
describe("H5 upload presets", () => {
  test("image preset caps at the size the photo route always used", () => {
    expect(PRESETS.image.maxBytes).toBe(8 * MB);
    expect(PRESETS.image.mimePatterns.some((re) => re.test("image/png"))).toBe(true);
    // the photo route's cap and the OCR routes' cap come from one place now
    expect(PHOTO_MAX_BYTES).toBe(PRESETS.image.maxBytes);
  });

  test("sheet preset allows the roster formats schools actually keep", () => {
    expect(PRESETS.sheet.maxBytes).toBe(10 * MB);
    for (const ext of [".xlsx", ".xlsm", ".xlsb", ".xls", ".csv"]) {
      expect(PRESETS.sheet.extensions).toContain(ext);
    }
  });

  test("every made upload bounds size, file count and body parts", () => {
    for (const preset of ["image", "sheet"]) {
      const u = makeUpload(preset);
      expect(u.limits.fileSize).toBe(PRESETS[preset].maxBytes);
      expect(u.limits.files).toBe(1);
      expect(u.limits.files).toBeGreaterThan(0);
      expect(typeof u.limits.fields).toBe("number");
      expect(typeof u.limits.parts).toBe("number");
      expect(typeof u.fileFilter).toBe("function");
    }
  });

  test("callers can tighten the cap or swap the storage", () => {
    expect(makeUpload("image", { maxBytes: 1 * MB }).limits.fileSize).toBe(1 * MB);
    const storage = { getDestination: jest.fn(), getFilename: jest.fn() };
    const u = makeUpload("image", { storage });
    expect(u.storage).toBe(storage);
    expect(u.limits.fileSize).toBe(PRESETS.image.maxBytes);
  });

  test("temp bodies are pinned to uploads/ — never RAM, never the OS tmp dir", () => {
    // multer's own defaults are memoryStorage() (no options) and os.tmpdir()
    // (disk with no destination). Either would put temp files where the
    // cleanup guard refuses to delete them, so the destination is asserted.
    const u = makeUpload("image");
    expect(typeof u.storage.getDestination).toBe("function");
    expect(typeof u.storage.getFilename).toBe("function");
    let dest;
    u.storage.getDestination({}, {}, (err, d) => (dest = d));
    expect(path.resolve(dest)).toBe(path.resolve(UPLOAD_DIR));
  });

  test("an unknown preset is a programming error, not a silent default", () => {
    expect(() => makeUpload("archives")).toThrow(/unknown preset/);
    expect(() => createFileFilter("archives")).toThrow(/unknown preset/);
  });
});

// ── type filtering ───────────────────────────────────────────────────────────
describe("H5 file filters", () => {
  const decide = (filter, file) =>
    new Promise((resolve) => filter({}, file, (err, ok) => resolve({ err, ok })));

  test("image route accepts pictures, including octet-stream with a picture name", async () => {
    const filter = createFileFilter("image");
    for (const [mimetype, originalname] of [
      ["image/png", "shot.png"],
      ["image/jpeg", "scan.jpg"],
      ["application/octet-stream", "IMG_0001.jpg"],
    ]) {
      expect(await decide(filter, { mimetype, originalname })).toEqual({ err: null, ok: true });
    }
  });

  test("image route refuses non-pictures", async () => {
    const filter = createFileFilter("image");
    for (const [mimetype, originalname] of [
      ["text/html", "payload.html"],
      ["application/php", "shell.php"],
      ["application/octet-stream", "meterpreter.exe"],
      ["text/plain", "notes.txt"],
    ]) {
      expect(await decide(filter, { mimetype, originalname })).toEqual({ err: null, ok: false });
    }
  });

  test("sheet route accepts workbooks and refuses pictures", async () => {
    const filter = createFileFilter("sheet");
    for (const [mimetype, originalname] of [
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "roster.xlsx"],
      ["application/vnd.ms-excel", "old.xls"],
      ["text/csv", "class-8.csv"],
      ["application/octet-stream", "legacy.xlsm"],
    ]) {
      expect(await decide(filter, { mimetype, originalname })).toEqual({ err: null, ok: true });
    }
    for (const [mimetype, originalname] of [
      ["image/png", "photo.png"],
      ["application/pdf", "report.pdf"],
      ["application/octet-stream", "installer.exe"],
    ]) {
      expect(await decide(filter, { mimetype, originalname })).toEqual({ err: null, ok: false });
    }
  });
});

// ── the cleanup guard ────────────────────────────────────────────────────────
describe("H5 temp-path guard", () => {
  test("only paths inside uploads/ are considered ours", () => {
    expect(isUploadTempPath(path.join(process.cwd(), UPLOAD_DIR, "abc123"))).toBe(true);
    expect(isUploadTempPath("uploads/abc123")).toBe(true);
    expect(isUploadTempPath(path.join(process.cwd(), "server.js"))).toBe(false);
    expect(isUploadTempPath("/etc/passwd")).toBe(false);
    expect(isUploadTempPath("uploads/../server.js")).toBe(false);
    expect(isUploadTempPath("")).toBe(false);
    expect(isUploadTempPath(undefined)).toBe(false);
    expect(isUploadTempPath({ path: "uploads/x" })).toBe(false);
  });

  test("a sibling whose name merely starts with the directory is not inside it", () => {
    // resolve("uploads") + sep must not match "uploads-backup/x"
    expect(isUploadTempPath(path.join(process.cwd(), "uploads-backup", "x"))).toBe(false);
  });

  test("removeUploadedFile deletes inside uploads/ and refuses elsewhere", async () => {
    const mine = makeUploadTempFile();
    expect(removeUploadedFile(mine)).toBe(true);
    expect(await fileGone(mine)).toBe(true);

    const outside = path.join(scratch, "keep-me.txt");
    fs.writeFileSync(outside, "do not delete");
    expect(removeUploadedFile(outside)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(removeUploadedFile(path.join(process.cwd(), "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "package.json"))).toBe(true);
  });

  test("removing something already gone is not an error", () => {
    const ghost = path.join(process.cwd(), UPLOAD_DIR, "h5-never-existed");
    expect(() => removeUploadedFile(ghost)).not.toThrow();
    expect(removeUploadedFile(ghost)).toBe(true);
  });
});

// ── cleanupUploadedFiles middleware ──────────────────────────────────────────
describe("H5 cleanup middleware", () => {
  const { EventEmitter } = require("events");

  const mkRes = () => {
    const res = new EventEmitter();
    res.destroy = jest.fn();
    return res;
  };

  test("passes through and unlinks single + multiple files when the response ends", async () => {
    const a = makeUploadTempFile();
    const b = makeUploadTempFile();
    const req = { file: { path: a }, files: { scans: [{ path: b }] } };
    const res = mkRes();
    let nextCalled = false;

    cleanupUploadedFiles(req, res, () => (nextCalled = true));
    expect(nextCalled).toBe(true);
    expect(fs.existsSync(a) && fs.existsSync(b)).toBe(true);

    res.emit("finish");
    expect(await fileGone(a)).toBe(true);
    expect(await fileGone(b)).toBe(true);
  });

  test("'finish' and 'close' together still remove each file once", async () => {
    const a = makeUploadTempFile();
    const b = makeUploadTempFile();
    const req = { file: { path: a }, files: { scans: [{ path: b }] } };
    const res = mkRes();
    cleanupUploadedFiles(req, res, () => {});
    const unlink = jest.spyOn(fs, "unlink");
    res.emit("close");
    res.emit("finish");
    expect(await fileGone(a)).toBe(true);
    expect(await fileGone(b)).toBe(true);
    // one syscall per file — 'close' and 'finish' must not double-unlink
    expect(unlink.mock.calls.map((c) => c[0]).sort()).toEqual([a, b].sort());
    unlink.mockRestore();
  });

  test("a request with no upload adds no listeners", () => {
    const res = mkRes();
    const before = res.listenerCount("finish");
    let nextCalled = false;
    cleanupUploadedFiles({}, res, () => (nextCalled = true));
    expect(nextCalled).toBe(true);
    expect(res.listenerCount("finish")).toBe(before);
  });

  test("paths outside uploads/ are never handed to unlink", () => {
    const outside = path.join(scratch, "not-an-upload.png");
    fs.writeFileSync(outside, "keep");
    const req = { file: { path: outside } };
    const res = mkRes();
    cleanupUploadedFiles(req, res, () => {});
    res.emit("finish");
    expect(fs.existsSync(outside)).toBe(true);
  });
});

// ── end-to-end over real HTTP with real multer + real disk ───────────────────
describe("H5 upload routes over HTTP", () => {
  let server;
  let app;
  let handlerSeen;

  beforeEach(() => {
    handlerSeen = null;
    app = buildApp(async (req, res) => {
      handlerSeen = req.file ? { path: req.file.path, size: req.file.size } : null;
      res.json({ status: "success", file: handlerSeen ? req.file.originalname : null });
    });
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  test("an over-cap body is refused and no partial file is left behind", async () => {
    server = await listen(app);
    const before = snapshotDir();
    const oversize = new Blob([Buffer.alloc(9 * MB, 0)], { type: "image/png" });

    const res = await server.post("/up", formWith(oversize));

    expect(res.status).toBe(413);
    expect(res.body).toMatch(/Upload too large/);
    expect(res.body).toMatch(/\(image\)/); // the offending field is named
    expect(snapshotDir()).toEqual(before); // multer aborted: nothing new on disk
  });

  test("a second file on a single-file route is refused (files:1)", async () => {
    server = await listen(app);
    const before = snapshotDir();
    const form = new FormData();
    form.append("image", new Blob([PNG_1PX], { type: "image/png" }), "a.png");
    form.append("extra", new Blob([PNG_1PX], { type: "image/png" }), "b.png");

    const res = await server.post("/up", form);

    // a volume/structure violation is not "too large" — the client fixes the
    // request, so it is a 400, and the first part is not left on disk
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/Upload rejected/);
    await sleep(150);
    expect(snapshotDir()).toEqual(before);
  });

  test("a non-picture part never reaches the temp directory", async () => {
    server = await listen(app);
    const before = snapshotDir();
    const evil = new Blob([Buffer.from("<?php system($_GET[0]); ?>", "utf8")], { type: "application/x-php" });

    const res = await server.post("/up", formWith(evil, "shell.php"));

    expect(res.status).toBe(200);
    expect(handlerSeen).toBe(null); // multer dropped the part → route's "no file" branch
    expect(res.body).toMatch(/"file":null/);
    expect(snapshotDir()).toEqual(before);
  });

  test("the accepted temp file is gone once a successful response is finished", async () => {
    server = await listen(app);
    const before = snapshotDir();

    const res = await server.post("/up", formWith(new Blob([PNG_1PX], { type: "image/png" })));

    expect(res.status).toBe(200);
    expect(handlerSeen).toBeTruthy();
    expect(isUploadTempPath(handlerSeen.path)).toBe(true);
    expect(await fileGone(handlerSeen.path, 3000)).toBe(true);
    expect(snapshotDir()).toEqual(before);
  });

  test("cleanup runs when the handler throws synchronously", async () => {
    app = buildApp((req) => {
      handlerSeen = { path: req.file.path };
      throw new Error("boom in handler");
    });
    server = await listen(app);

    const res = await server.post("/up", formWith(new Blob([PNG_1PX], { type: "image/png" })));

    expect(res.status).toBe(500);
    expect(await fileGone(handlerSeen.path, 3000)).toBe(true);
  });

  test("cleanup runs when the handler rejects (H4 boundary → error handler)", async () => {
    app = buildApp(async (req) => {
      handlerSeen = { path: req.file.path };
      await Promise.resolve().then(() => {
        throw new Error("db hiccup during upload handling");
      });
    });
    server = await listen(app);

    const res = await server.post("/up", formWith(new Blob([PNG_1PX], { type: "image/png" })));

    expect(res.status).toBe(500);
    expect(res.body).toMatch(/db hiccup/);
    expect(await fileGone(handlerSeen.path, 3000)).toBe(true);
  });

  test("cleanup runs when the client aborts mid-response", async () => {
    app = buildApp(async (req, res) => {
      handlerSeen = { path: req.file.path };
      res.setHeader("Content-Type", "application/octet-stream");
      res.write(Buffer.alloc(64 * 1024));
      // never end() — the client gives up and the socket closes
    });
    server = await listen(app);
    const url = `http://127.0.0.1:${server.port}/up`;
    const controller = new AbortController();
    const pending = fetch(url, { method: "POST", body: formWith(new Blob([PNG_1PX], { type: "image/png" })), signal: controller.signal }).catch(() => null);
    await sleep(300);
    controller.abort();
    await pending;

    expect(await fileGone(handlerSeen.path, 3000)).toBe(true);
  });

  test("without the middleware the temp file is left behind (documents the fix)", async () => {
    app = express();
    app.post("/up", makeUpload("image").single("image"), (req, res) => {
      handlerSeen = { path: req.file.path };
      res.json({ ok: true });
    });
    server = await listen(app);

    const res = await server.post("/up", formWith(new Blob([PNG_1PX], { type: "image/png" })));

    expect(res.status).toBe(200);
    expect(fs.existsSync(handlerSeen.path)).toBe(true); // ← the pre-fix leak
    fs.unlinkSync(handlerSeen.path);
  });
});

// ── orphan sweep ─────────────────────────────────────────────────────────────
describe("H5 orphan upload sweep", () => {
  const touch = (name, ageMs = 0) => {
    const full = path.join(scratch, name);
    fs.writeFileSync(full, "x");
    if (ageMs) {
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(full, when, when);
    }
    return full;
  };

  test("removes stale extensionless blobs only", () => {
    const stale = touch("sweep-stale-blob", 2 * 60 * 60 * 1000); // 2h old
    const fresh = touch("sweep-fresh-blob", 0);
    const kept = touch("photo.jpg", 2 * 60 * 60 * 1000);
    const dir = path.join(scratch, "photos");
    fs.mkdirSync(dir, { recursive: true });
    touch(path.join("photos", "inside.jpg"), 2 * 60 * 60 * 1000);

    const removed = sweepOrphanUploads(60 * 60 * 1000, scratch); // older than 1h

    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(path.join(dir, "inside.jpg"))).toBe(true);
  });

  test("a missing directory is not an error", () => {
    expect(sweepOrphanUploads(1000, path.join(scratch, "nope"))).toBe(0);
  });

  test("the production interval is scheduled on the real app, not under jest", () => {
    const source = fs.readFileSync(path.join(__dirname, "../app/app.js"), "utf8");
    expect(source).toMatch(/sweepOrphanUploads\(\)/);
    // inside the NODE_ENV !== "test" guard alongside the PDF sweep
    const guard = source.indexOf('if (process.env.NODE_ENV !== "test")');
    expect(source.indexOf("sweepOrphanUploads()", guard)).toBeGreaterThan(guard);
  });
});

// ── services: unlink on the paths that used to leak ──────────────────────────
describe("H5 OCR/import services clean up on failure", () => {
  // The services construct GoogleGenAI at module load, so the mock has to exist
  // before they are required.
  let mockGenerateContent;
  let mockXlsxReadFile;
  let ocrServices;
  let importService;

  beforeAll(() => {
    // The shared Gemini wrapper builds its key pool lazily from env; this suite
    // only exercises cleanup paths, so one dummy key and a mocked SDK suffice.
    process.env.GEMINI_API_KEY = "h5-test-key";
    jest.isolateModules(() => {
      mockGenerateContent = jest.fn();
      jest.doMock("@google/genai", () => ({
        GoogleGenAI: jest.fn().mockImplementation(() => ({
          models: { generateContent: (...args) => mockGenerateContent(...args) },
        })),
      }));
      // A workbook XLSX refuses to open is the real-world import failure (wrong
      // export, .xls saved as .xlsx, truncated download). Mocking readFile keeps
      // that path deterministic instead of depending on how lenient xlsx is.
      mockXlsxReadFile = jest.fn(() => {
        throw new Error("Corrupt workbook");
      });
      jest.doMock("xlsx", () => ({
        readFile: (...args) => mockXlsxReadFile(...args),
        utils: { sheet_to_json: jest.fn(() => []) },
        version: "test",
      }));
      ocrServices = {
        fees: require("../services/fees/ocr.service"),
        marks: require("../services/academic/marksOcr.service"),
        gemini: require("../utils/geminiClient"),
      };
      importService = require("../services/students/studentImport.service");
    });
  });

  beforeEach(() => {
    // Fresh key pool per case: a 429 cooldown from one test must not make the
    // next test's call skip the SDK mock entirely.
    ocrServices.gemini.__resetGeminiPoolForTesting();
    mockGenerateContent.mockReset();
  });

  const mkRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnThis();
    res.json = jest.fn().mockReturnThis();
    return res;
  };

  test("fee OCR: unparseable model output (an early return) still unlinks", async () => {
    const file = makeUploadTempFile();
    mockGenerateContent.mockResolvedValue({ text: "this is not json" });

    const res = mkRes();
    await ocrServices.fees.extractFeesFromImageService(file, "image/png", res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(await fileGone(file)).toBe(true);
  });

  test("fee OCR: a Gemini failure still unlinks", async () => {
    const file = makeUploadTempFile();
    mockGenerateContent.mockRejectedValue(Object.assign(new Error("quota"), { status: 429 }));

    const res = mkRes();
    await ocrServices.fees.extractFeesFromImageService(file, "image/png", res);

    // Failover wrapper: the 429 cools the only key down, so the service answers
    // 503 with the specific quota/busy message — never an empty result.
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0].message).toMatch(/quota reached or service busy/);
    expect(await fileGone(file)).toBe(true);
  });

  test("marks OCR: unparseable model output still unlinks", async () => {
    const file = makeUploadTempFile();
    mockGenerateContent.mockResolvedValue({ text: "```json\n[broken" });

    const res = mkRes();
    await ocrServices.marks.extractMarksFromImageService(file, "image/jpeg", res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(await fileGone(file)).toBe(true);
  });

  test("marks OCR: success path unlinks too", async () => {
    const file = makeUploadTempFile();
    mockGenerateContent.mockResolvedValue({ text: '[{"name":"Ali","score":42}]' });

    const res = mkRes();
    await ocrServices.marks.extractMarksFromImageService(file, "image/jpeg", res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(await fileGone(file)).toBe(true);
  });

  test("excel import: a corrupt workbook unlinks instead of stranding it", async () => {
    const file = makeUploadTempFile(Buffer.from("this is not a workbook"), "h5-corrupt.xlsx");
    const res = mkRes();

    await expect(importService.parseStudentExcelService(file, res)).rejects.toThrow("Corrupt workbook");
    expect(mockXlsxReadFile).toHaveBeenCalledWith(file);
    expect(await fileGone(file)).toBe(true);
  });

  test("services never unlink outside uploads/", async () => {
    const outside = path.join(scratch, "not-an-upload.xlsx");
    fs.writeFileSync(outside, "keep me");
    mockGenerateContent.mockResolvedValue({ text: "not json" });

    await ocrServices.fees.extractFeesFromImageService(outside, "image/png", mkRes());

    expect(fs.existsSync(outside)).toBe(true);
  });
});

// ── wiring: no hand-rolled multer left, cleanup mounted everywhere ──────────
describe("H5 call-site wiring", () => {
  const routeFiles = execSync("git ls-files 'routes/**/*.js'", { cwd: path.join(__dirname, "..") })
    .toString()
    .trim()
    .split("\n");

  test("only the factory constructs a multer instance", () => {
    const offenders = routeFiles.filter((f) => {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      return /multer\(/.test(src.replace(/multer\.diskStorage\(/g, ""));
    });
    expect(offenders).toEqual([]);
  });

  test("every temp-upload route mounts cleanupUploadedFiles", () => {
    const offenders = [];
    for (const f of routeFiles) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      src.split("\n").forEach((line, i) => {
        // \b blocks the permanent photo route's `photoUpload.single(...)`
        if (/\bupload\.single\(/.test(line) && !/cleanupUploadedFiles/.test(line)) {
          offenders.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the photo routes that keep their file deliberately skip cleanup", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../routes/v1/students/students.router.js"),
      "utf8"
    );
    expect(src).toMatch(/photoUpload\.single\("photo"\)/);
    expect(src).toMatch(/makeUpload\("image", \{/);
    // one file per route line → cleanup would delete the kept photo
    const photoLine = src.split("\n").find((l) => /photoUpload\.single\(/.test(l));
    expect(photoLine).not.toMatch(/cleanupUploadedFiles/);
  });

  test("the routes that took the sheet preset are the import routes", () => {
    for (const f of ["routes/views/studentImport.views.js", "routes/v1/students/students.router.js"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      expect(src).toMatch(/makeUpload\("sheet"\)/);
    }
  });

  test("the global error handler tells 'too big' apart from 'broken'", () => {
    const src = fs.readFileSync(path.join(__dirname, "../middlewares/errorHandler.js"), "utf8");
    expect(src).toMatch(/MulterError/);
    expect(src).toMatch(/LIMIT_FILE_SIZE/);
    expect(src).toMatch(/413/);
  });
});
