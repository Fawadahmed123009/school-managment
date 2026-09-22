// Throwaway static server used only to verify the shared ClassPicker component
// in the browser preview. Serves the real /public assets (so the actual
// class-picker.js + style.css are exercised) and a harness page at "/".
// Safe to delete once verification is done.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 4599;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const HARNESS = path.join(__dirname, "cpicker-harness.html");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// Mirror the production Helmet CSP from app/app.js (no 'unsafe-inline' on
// script-src) so we can observe whether inline <script> blocks are blocked.
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

http
  .createServer((req, res) => {
    res.setHeader("Content-Security-Policy", PROD_CSP);
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/" || urlPath === "/index.html") {
      return fs.readFile(HARNESS, (err, buf) => {
        if (err) {
          res.writeHead(500);
          return res.end("harness missing");
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buf);
      });
    }
    const safe = path.normalize(urlPath).replace(/^([/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      });
      res.end(buf);
    });
  })
  .listen(PORT, () => console.log("cpicker harness on http://localhost:" + PORT));
