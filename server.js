require("dotenv").config();

// ── Crash handlers — registered BEFORE any app requires ──────────
// If a top-level require throws (e.g. sharp native binary missing),
// these ensure the error is visible instead of silently killing the process.
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message || err);
  console.error(err.stack || "");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason?.message || reason);
  console.error(reason?.stack || "");
});

const http = require("http");
require("colors");
const logger = require("./config/logger");
const app = require("./app/app");
// database connection
require("./config/dbConnect");

// ── Port / pipe ──────────────────────────────────────────────
// • Local dev:    process.env.PORT is undefined → falls back to 3001.
// • iisnode:      process.env.PORT is a named-pipe path (\\.\pipe\…).
// • Other prod:   process.env.PORT is set by the host (e.g. 80, 443).
const port = process.env.PORT || 3001;

// initialize server
const server = http.createServer(app);

server.listen(port, () => {
  logger.info(`Server running on port ${port}`);
  console.log(` server is running on port : ${port} `.black.bgGreen.bold);
});

// ── Graceful shutdown (iisnode recycles the worker) ──────────
function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
  // Force exit after 10 s if connections didn't drain
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ── Unhandled rejections & exceptions ─────────────────────────
// NOTE: The primary uncaughtException / unhandledRejection handlers
// are registered at the top of this file (before any app requires)
// so they catch errors during module loading too. The handlers below
// upgrade logging to use Winston once the logger is available.
process.removeAllListeners("uncaughtException");
process.removeAllListeners("unhandledRejection");

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Rejection:", { reason: reason?.message || reason, stack: reason?.stack });
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception:", { message: err.message, stack: err.stack });
  console.error("Uncaught Exception:", err.message);
  process.exit(1);
});
