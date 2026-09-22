/**
 * Cloud archive for OCR scan photos (fee sheets / marks sheets).
 *
 * Every image that goes through the "photo to ledger" / "photo to marks"
 * flows is kept as evidence in Cloudflare R2, in separate top-level
 * prefixes (the R2 equivalent of directories):
 *   fee-scans/<sha256-of-image>.jpg
 *   marks-scans/<sha256-of-image>.jpg
 *
 * The content hash doubles as the filename, so rescanning the same photo
 * (e.g. a retry after an OCR error) never creates duplicate objects.
 * When R2 is not configured we fall back to local disk under
 * uploads/<prefix>/ (served only to authenticated users).
 *
 * Archiving is best-effort: a failure here must never break the OCR flow.
 */
const crypto = require("crypto");
const { uploadToR2, saveLocally, isR2Configured } = require("../../utils/r2Client");

let sharp;
try {
  sharp = require("sharp");
} catch (_) {
  // sharp native binary unavailable — archives are stored uncompressed
}

const SCAN_KINDS = {
  fee: "fee-scans",
  marks: "marks-scans",
};

// Documents stay legible when capped at ~2 MP — enough to read handwriting
// while keeping archives small.
const MAX_SCAN_WIDTH = 2000;

const compressScan = async (buffer) => {
  if (!sharp) return { buffer, contentType: "image/jpeg" };
  try {
    const out = await sharp(buffer)
      .rotate() // honour EXIF orientation from phone cameras
      .resize({ width: MAX_SCAN_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    return { buffer: out, contentType: "image/jpeg" };
  } catch (_) {
    return { buffer, contentType: "image/jpeg" }; // not a decodable image — keep raw
  }
};

/**
 * Archive one scan photo.
 * @param {"fee"|"marks"} kind   — picks the R2 prefix
 * @param {Buffer} buffer        — raw uploaded image bytes
 * @returns {{url: string, key: string}|null} null when storage is unavailable
 */
exports.archiveOcrScan = async (kind, buffer) => {
  const prefix = SCAN_KINDS[kind];
  if (!prefix || !buffer || !buffer.length) return null;

  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  const { buffer: outBuffer, contentType } = await compressScan(buffer);
  const filename = `${hash}.jpg`;

  if (isR2Configured()) {
    const url = await uploadToR2(`${prefix}/${filename}`, outBuffer, contentType);
    return { url, key: `${prefix}/${filename}` };
  }

  // Local fallback — saved under uploads/<prefix>/ which is served to
  // authenticated users only (see app.js /uploads guard).
  const url = saveLocally(prefix, filename, outBuffer);
  return { url, key: `${prefix}/${filename}` };
};

exports.SCAN_KINDS = SCAN_KINDS;
