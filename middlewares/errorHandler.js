const logger = require("../config/logger");

/**
 * Global error-handling middleware.
 * Mount AFTER all routes. Catches any error passed via next(err)
 * or thrown in async route handlers (with express-async-errors or wrap).
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, _next) => {
  // H4: an error can now arrive *after* a response started (a late rejection
  // on a request that already began streaming). Adding status/headers then
  // would throw ERR_HTTP_HEADERS_SENT and take the worker down — so cut the
  // connection instead: the client sees a clean failure, not a hung socket.
  if (res.headersSent || res.writableEnded) {
    logger.error(`${req.method} ${req.originalUrl} — post-response error: ${err && err.message}`, {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      stack: err && err.stack,
    });
    try {
      res.destroy();
    } catch (_) {
      /* socket already gone */
    }
    return;
  }

  // Log the full error to file + console
  logger.error(`${req.method} ${req.originalUrl} — ${err.message}`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    stack: err.stack,
  });

  try {
    return sendError(err, req, res);
  } catch (sendErr) {
    // Last resort: never let error handling itself become an uncaught
    // exception (server.js exits the process on one).
    logger.error(`${req.method} ${req.originalUrl} — error handler failed: ${sendErr.message}`, {
      stack: sendErr.stack,
    });
    return res.status(500).json({ status: "failed", message: "Internal server error" });
  }
};

// Status/body mapping for a pending response.
const sendError = (err, req, res) => {
  // Mongoose validation error
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      status: "failed",
      message: messages.join(", "),
    });
  }

  // Mongoose cast error (bad ObjectId)
  if (err.name === "CastError") {
    return res.status(400).json({
      status: "failed",
      message: `Invalid ${err.path}: ${err.value}`,
    });
  }

  // Duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || "field";
    return res.status(409).json({
      status: "failed",
      message: `Duplicate value for ${field}`,
    });
  }

  // JWT errors
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return res.status(401).json({
      status: "failed",
      message: "Invalid or expired token",
    });
  }

  // Default: 500
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    status: "failed",
    message:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
};

module.exports = errorHandler;
