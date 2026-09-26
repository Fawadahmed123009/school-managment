/**
 * H5 — the single place upload routes are configured.
 *
 * Before this module every OCR / import route built its own multer with
 * `multer({ dest: "uploads/" })`: no size cap, no type filter, no file-count
 * cap. Any client could stream arbitrarily large (or arbitrarily many) bodies
 * straight to disk — a disk-fill DoS on the box that also takes the DB and
 * every other request down with it. Only the student-photo route got it right
 * (size cap + mime filter); this factory is that pattern, shared.
 *
 * What each upload route is expected to use:
 *
 *   const { makeUpload, cleanupUploadedFiles } = require("../../utils/uploadFactory");
 *   const upload = makeUpload("image");                 // or "sheet"
 *   router.post("/…", upload.single("image"), cleanupUploadedFiles, handler);
 *
 * `cleanupUploadedFiles` is what makes cleanup *reliable*: the temp file is
 * removed when the response closes, so it is removed on the happy path, on a
 * route-level `catch`, on a validation failure, and on an uncaught async
 * rejection handed to the error handler (H4) — not just when the handler
 * happens to reach its own `fs.unlink` line.
 *
 * Note on the *permanent* photo upload (routes/v1/students/students.router.js):
 * that route uses diskStorage to write a file we intentionally keep, so it
 * takes the factory's limits + type filter but MUST NOT get the cleanup
 * middleware.
 */
const fs = require("fs");
const path = require("path");
const multer = require("multer");

/** Where multer writes temp bodies (also the photo fallback dir). */
const UPLOAD_DIR = "uploads/";

const MB = 1024 * 1024;

const PRESETS = {
  // Camera snaps / scanned fee & marks sheets. 8 MB is the cap the student-photo
  // route has always used, so nothing that uploaded before can start failing now.
  image: {
    label: "image",
    maxBytes: 8 * MB,
    mimePatterns: [/^image\//i],
    // Used only when the client reports a generic binary MIME (see below).
    extensions: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"],
  },
  // Student roster imports. Excel/Sheets workbooks plus CSV; .xlsm/.xlsb are
  // macro-formats a school genuinely keeps old rosters in, and browsers often
  // report them as application/octet-stream — the extension is the only signal.
  sheet: {
    label: "spreadsheet",
    maxBytes: 10 * MB,
    mimePatterns: [
      /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/i,
      /^application\/vnd\.ms-excel$/i,
      /^application\/excel$/i,
      /^text\/csv$/i,
      /^application\/csv$/i,
      /^application\/vnd\.ms-excel\.macroenabled\./i,
    ],
    extensions: [".xlsx", ".xlsm", ".xlsb", ".xls", ".csv"],
  },
};

/** Cap for the permanent student-photo upload (kept as one number, see router). */
const PHOTO_MAX_BYTES = 8 * MB;

// A single request carries one file plus a couple of small fields (CSRF token,
// testId …). `fields`/`parts` bound the rest of the multipart body so a crafted
// "many tiny parts" request can't pin the parser either; both stay well above
// what the real forms send (file + CSRF + one or two ids).
const BASE_LIMITS = { files: 1, fields: 20, parts: 25 };

/**
 * Type filter, kept as a standalone function so it is unit-testable and so
 * callers can see exactly what "not allowed" means.
 *
 * Accepts a part when its MIME says "image" / "spreadsheet", or when the MIME
 * is a generic "some binary blob" marker and the filename carries an allowed
 * extension (plenty of browsers and tools send application/octet-stream for a
 * perfectly ordinary .xlsx or .jpg). Anything else — a real text/html, php,
 * exe … upload — is refused.
 *
 * Rejection is `cb(null, false)`: multer discards that part without ever
 * writing it to disk and the route reports "no file uploaded". That is the
 * long-standing behavior of the photo route this factory replicates; an
 * over-size file is still aborted with a MulterError by `limits.fileSize`.
 */
const GENERIC_MIMES =
  /^(application\/octet-stream|application\/binary|application\/unknown-binary-data|application\/download|application\/x-msdownload)$/i;

const createFileFilter = (presetName) => {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`uploadFactory: unknown preset "${presetName}"`);

  return (req, file, cb) => {
    const mime = (file && file.mimetype) || "";
    const ext = path.extname((file && file.originalname) || "").toLowerCase();
    const mimeOk = preset.mimePatterns.some((re) => re.test(mime));
    const extOk = preset.extensions.includes(ext);
    if (mimeOk || (extOk && (!mime || GENERIC_MIMES.test(mime)))) return cb(null, true);
    return cb(null, false);
  };
};

/**
 * Build a hardened multer instance.
 *
 * @param {"image"|"sheet"} presetName
 * @param {{dest?: string, storage?: object, maxBytes?: number}} [options]
 *        `dest` / `maxBytes` override the preset; `storage` (e.g. the photo
 *        route's diskStorage) replaces `dest` entirely.
 */
const makeUpload = (presetName = "image", options = {}) => {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`uploadFactory: unknown preset "${presetName}"`);

  return multer({
    ...(options.storage ? { storage: options.storage } : { dest: options.dest || UPLOAD_DIR }),
    limits: {
      ...BASE_LIMITS,
      fileSize: options.maxBytes || preset.maxBytes,
    },
    fileFilter: createFileFilter(presetName),
  });
};

/** True when `target` is a file inside our uploads directory (never elsewhere). */
const isUploadTempPath = (target) => {
  if (typeof target !== "string" || !target) return false;
  const root = path.resolve(UPLOAD_DIR) + path.sep;
  const abs = path.resolve(target);
  return abs.startsWith(root);
};

/** Best-effort temp removal — a missing/unlinked file is never an error. */
const removeUploadedFile = (target) => {
  if (!isUploadTempPath(target)) return false;
  try {
    fs.unlink(target, () => {});
  } catch (_) {
    // fs mocked without unlink (or already gone) — cleanup is best-effort
  }
  return true;
};

/**
 * Middleware to mount immediately AFTER multer on upload routes: guarantees the
 * temp file is unlinked when the response ends, however the handler exited.
 */
const cleanupUploadedFiles = (req, res, next) => {
  const paths = [];
  if (req.file) paths.push(req.file.path);
  if (req.files) {
    for (const group of Object.values(req.files)) {
      for (const f of Array.isArray(group) ? group : [group]) paths.push(f.path);
    }
  }
  const tempPaths = paths.filter(Boolean);
  if (!tempPaths.length) return next();

  let swept = false;
  const removeAll = () => {
    if (swept) return;
    swept = true;
    for (const p of tempPaths) removeUploadedFile(p);
  };
  // 'finish' = response fully sent; 'close' = connection ended (incl. client
  // aborts and the socket teardown path in the error handler). Either one is
  // enough, and the flag keeps a response that fires both from unlinking twice
  // (the name can already belong to a new upload by then).
  res.once("finish", removeAll);
  res.once("close", removeAll);
  return next();
};

/**
 * Safety net for uploads that never reach a response (worker killed mid-upload,
 * aborted socket before 'close' could run): delete multer temp files — plain
 * extensionless blobs in UPLOAD_DIR — older than `maxAgeMs`. Files with an
 * extension and the photos/ fee-scans/ marks-scans/ subdirectories are untouched.
 *
 * @returns {number} how many files were removed
 */
const sweepOrphanUploads = (maxAgeMs = 60 * 60 * 1000, dir = UPLOAD_DIR) => {
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return removed; // no uploads dir yet
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (path.extname(name)) continue; // real assets keep their extension
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      fs.unlinkSync(full);
      removed += 1;
    } catch (_) {
      // raced with another removal / not ours to delete — never fatal
    }
  }
  return removed;
};

module.exports = {
  UPLOAD_DIR,
  PRESETS,
  PHOTO_MAX_BYTES,
  makeUpload,
  createFileFilter,
  cleanupUploadedFiles,
  removeUploadedFile,
  isUploadTempPath,
  sweepOrphanUploads,
};
