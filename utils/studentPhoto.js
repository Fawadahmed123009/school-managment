const fs = require("fs");
const path = require("path");

/**
 * Shared student-photo resolver.
 *
 * A student's `photoUrl` may be either:
 *   • a full remote URL (https://… — Cloudflare R2 / CDN), or
 *   • a local relative path (/uploads/… — used when R2 is not configured).
 *
 * Both the export pipeline (PDF/DOCX/XLSX) and the report/analysis PDFs need
 * to turn that value into image bytes. Historically only the PDF reports
 * handled the local-path case; the export's plain fetch() threw on the
 * malformed relative URL and silently dropped the photo. This single helper
 * is the one code path both sides use, so local-storage deployments get
 * photos consistently.
 *
 * Never throws: returns { buffer, type } on success or null on any failure,
 * so a missing/corrupt photo can't break an export or report.
 */

// Detect the real image type from the bytes themselves — never from the URL
// extension or a claimed content-type (that guessing caused past corruption
// bugs). Returns "png" | "jpg" | "gif", or null if unsupported.
function detectImageType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.slice(0, 3).toString("ascii") === "GIF") return "gif";
  return null;
}

async function readLocalFile(photoUrl) {
  try {
    // Resolve relative to the process working directory, same convention the
    // rest of the app uses for /uploads static serving.
    const filePath = path.join(process.cwd(), photoUrl);
    const buffer = await fs.promises.readFile(filePath);
    const type = detectImageType(buffer);
    if (!type) return null;
    return { buffer, type };
  } catch {
    return null;
  }
}

async function fetchRemoteImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const type = detectImageType(buffer);
    if (!type) return null;
    return { buffer, type };
  } catch {
    return null;
  }
}

/**
 * Resolve a photoUrl (remote URL or local /path) to { buffer, type } or null.
 */
async function loadStudentPhoto(photoUrl) {
  if (!photoUrl) return null;
  const value = String(photoUrl);
  if (value.startsWith("/")) return readLocalFile(value);
  return fetchRemoteImage(value);
}

module.exports = { loadStudentPhoto, detectImageType };
