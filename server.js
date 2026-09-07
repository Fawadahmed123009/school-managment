require("dotenv").config();
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
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Rejection:", { reason: reason?.message || reason, stack: reason?.stack });
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception:", { message: err.message, stack: err.stack });
  console.error("Uncaught Exception:", err.message);
  process.exit(1);
});
