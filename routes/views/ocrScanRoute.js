/**
 * Auth-gated viewer for archived OCR scan photos (fee-scans / marks-scans).
 *
 * R2 objects live in a private bucket, so the scan is streamed through this
 * route instead of exposing the bucket publicly. Local-fallback archives
 * (uploads/<prefix>/…) are already served by the auth-guarded /uploads
 * static handler in app.js, so they don't need this endpoint.
 *
 * Usage from a view router:
 *   registerOcrScanViewRouter(router, { pattern: "/fees/ocr/scan", role: "admin" });
 */
const path = require("path");
const fs = require("fs");
const { requireRole } = require("../../middlewares/authView");
const { SCAN_KINDS } = require("../../services/fees/ocrScanArchive.service");

// Allowed archive prefixes → public URL segments they may appear as.
const ALLOWED_HOSTS = (() => {
  const hosts = Object.values(SCAN_KINDS).map((p) => p + "/");
  hosts.push("uploads/" + SCAN_KINDS.fee + "/", "uploads/" + SCAN_KINDS.marks + "/");
  return hosts;
})();

module.exports = function registerOcrScanViewRouter(router, { pattern, role }) {
  router.get(pattern, requireRole(role), async (req, res) => {
    const url = req.query.url || "";

    // Only serve archived scans from the prefixes this app writes to —
    // no arbitrary-URL proxying.
    const allowed = ALLOWED_HOSTS.some((p) => url.includes("/" + p) || url.startsWith(p));
    if (!allowed) return res.status(400).send("Bad request");

    // Local fallback file: resolve it and stream from disk.
    if (url.startsWith("/uploads/")) {
      const filePath = path.join(process.cwd(), path.normalize(url));
      if (!filePath.startsWith(path.join(process.cwd(), "uploads")) || !fs.existsSync(filePath)) {
        return res.status(404).send("Not found");
      }
      return res.sendFile(filePath);
    }

    // R2 object: fetch and stream.
    try {
      const upstream = await fetch(url);
      if (!upstream.ok) return res.status(404).send("Not found");
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.send(buf);
    } catch (err) {
      return res.status(404).send("Not found");
    }
  });
};
