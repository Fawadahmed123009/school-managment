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
  // CORS refusal (utils/corsPolicy.js throws from the origin callback). This is
  // the policy rejecting a request, not the server failing — and it is exactly
  // what teachers saw as "Internal Server Error" when the mark-entry page's
  // same-origin PATCH (total/pass marks) was misjudged as cross-origin. A 403
  // with a readable reason lets the client surface something actionable.
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({
      status: "failed",
      message:
        "This request came from an address the site does not accept. Open the page again from the school's own address and try once more.",
    });
  }

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

  // body-parser rejections. Both arrive as plain Errors carrying a numeric
  // `status` plus a `type`, and both were falling through to the 500 default:
  //   • entity.parse.failed — the request body was not valid JSON/form data
  //     (a malformed or truncated payload, e.g. a save interrupted in flight),
  //     which is a bad request, not a server fault;
  //   • entity.too.large    — the body crossed the 1mb parse cap (a very long
  //     roster posted as JSON), so the client's fix is to send less at once.
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      status: "failed",
      message: "The request could not be read. Please reload the page and try again.",
    });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      status: "failed",
      message: "The request was too large to process. Please enter fewer scores at a time.",
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

  // H5: multer aborts a request that breaks an upload limit (size, file count,
  // unexpected field) and hands the MulterError here. Without this branch an
  // oversized upload would read as a 500 "Internal server error" — the client
  // can't tell "too big" from "server broken", and the OCR/import UIs show a
  // meaningless failure. Only the byte-size cap is a 413 ("send a smaller
  // file"); too many files/parts or a stray field is a malformed request, so
  // the client's fix is structural → 400.
  if (err.name === "MulterError") {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : 400).json({
      status: "failed",
      message: tooBig
        ? `Upload too large: ${err.message}${err.field ? ` (${err.field})` : ""}`
        : `Upload rejected: ${err.message}${err.field ? ` (${err.field})` : ""}`,
    });
  }

  // JWT errors
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return res.status(401).json({
      status: "failed",
      message: "Invalid or expired token",
    });
  }

  // Default: the error's own status when it declares one, else 500.
  // `statusCode` is this codebase's convention; third-party errors (body-parser,
  // jsonwebtoken, …) use `status`, and honouring it keeps a client/request fault
  // from being reported as a server failure.
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    status: "failed",
    // Only a genuine server fault (5xx) is masked in production — a 4xx carries
    // a client-facing reason that helps the teacher fix the input instead of
    // guessing at a broken server.
    message:
      process.env.NODE_ENV === "production" && statusCode >= 500
        ? "Internal server error"
        : err.message,
  });
};

module.exports = errorHandler;
