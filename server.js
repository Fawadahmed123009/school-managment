require("dotenv").config();
const http = require("http");
require("colors");
const logger = require("./config/logger");
const app = require("./app/app");
// database connection
require("./config/dbConnect");
// ports
const port = process.env.PORT || 3001;
// initialize server
const server = http.createServer(app);

server.listen(port, () => {
  logger.info(`Server running on port ${port}`);
  console.log(` server is running on port : ${port} `.black.bgGreen.bold);
});

// ── Unhandled rejections & exceptions ─────────────────────────
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Rejection:", { reason: reason?.message || reason, stack: reason?.stack });
  console.error("Unhandled Rejection:", reason);
  // Gracefully shut down & restart in production
  server.close(() => process.exit(1));
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception:", { message: err.message, stack: err.stack });
  console.error("Uncaught Exception:", err.message);
  process.exit(1);
});
