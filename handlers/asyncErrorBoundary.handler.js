/**
 * H4 — Async error boundary for the whole router stack.
 *
 * Express 4 only catches what a handler does *synchronously*. An `async`
 * handler that rejects returns a promise nobody awaits: the router has
 * already moved on, so `next(err)` is never called. The request therefore
 * never gets a response — it hangs until the client/proxy times out — and
 * the rejection surfaces as an `unhandledRejection` (or, if it escapes while
 * a response is being written, an `uncaughtException`, which server.js turns
 * into `process.exit(1)`). A DB hiccup (mongoose timeout, dropped Atlas
 * connection) was thus a hang or a worker crash instead of an error response.
 *
 * This module closes that gap at the ROUTER BOUNDARY — one install call, no
 * per-controller wrapper, no extra dependency. It walks the mounted stack and
 * replaces each handler with a version that binds the returned promise's
 * rejection to `next(err)`, so every async failure follows Express's normal
 * error pipeline and lands in `middlewares/errorHandler`.
 *
 * Behavior-preserving by construction:
 *   • Nothing changes on the success path. Only the rejection branch is
 *     added; a handler that resolves (whether or not it called `next`) is
 *     left exactly as Express saw it before.
 *   • Sync throws are not re-wrapped — Express already try/catches them —
 *     but the boundary stays correct if one ever slips through.
 *   • Error-handling layers (arity 4) are skipped: they are invoked through
 *     `Layer.prototype.handle_error`, and re-passing their own failure to
 *     `next(err)` could loop the error pipeline.
 *   • A rejection arriving AFTER the response was already sent/ended is
 *     dropped instead of calling `next(err)` on a finished response
 *     (that would only produce a second "headers already sent" error).
 *   • Mounted sub-routers are recursed into, never replaced, so a router
 *     object reused by other apps keeps its own behavior.
 */

const WRAPPED = Symbol.for("school-mgmt.asyncBoundary");

/**
 * @param {Function} fn original layer handler
 * @returns {Function|null} the wrapped handler, or null when `fn` must be
 *                          left untouched (non-function, already wrapped,
 *                          or an error-handling layer).
 */
const wrapHandler = (fn) => {
  if (typeof fn !== "function") return null;
  if (fn[WRAPPED]) return null; // idempotent: re-installing is a no-op
  if (fn.length > 3) return null; // error middleware — see note above

  const wrapped = function (req, res, next) {
    let settled = false;

    // Bind a rejection to the error pipeline, at most once, and only while
    // the response can still be produced by a downstream handler.
    const reject = (err) => {
      if (settled || res.headersSent || res.writableEnded) return;
      settled = true;
      next(err);
    };

    let out;
    try {
      out = fn.call(this, req, res, next);
    } catch (err) {
      // Express normally catches this first; harmless double-cover.
      reject(err);
      return;
    }

    if (out && typeof out.then === "function") {
      // Success: the handler owns the flow (it responded and/or called next).
      out.then(undefined, reject);
    }
    return out;
  };

  Object.defineProperty(wrapped, WRAPPED, { value: true });
  Object.defineProperty(wrapped, "name", { value: `asyncBoundary(${fn.name || "handler"})` });
  return wrapped;
};

/**
 * Recursively wrap every handler in a router/app stack (in place).
 * @param {Array} stack express Layer array (`router.stack`)
 * @returns {number} how many handlers were wrapped (for verification/tests)
 */
const wrapStack = (stack) => {
  if (!Array.isArray(stack)) return 0;
  let count = 0;

  for (const layer of stack) {
    const handle = layer && layer.handle;
    if (!handle) continue;

    if (layer.route) {
      // router.get('/x', a, b) → handlers live on the Route's own stack.
      count += wrapStack(layer.route.stack);
    } else if (Array.isArray(handle.stack)) {
      // Mounted sub-router (app.use('/api', router)) — descend, don't replace.
      count += wrapStack(handle.stack);
    } else {
      const wrapped = wrapHandler(handle);
      if (wrapped) {
        layer.handle = wrapped;
        count += 1;
      }
    }
  }

  return count;
};

/**
 * Install the boundary over an express application (or a bare router).
 * Call ONCE, after every route/middleware has been mounted and before the
 * global error handler is relied upon — i.e. last thing in app.js.
 *
 * @param {Function} app express application or Router
 * @returns {number} number of handlers wrapped
 */
const installAsyncErrorBoundary = (app) => {
  if (!app) return 0;
  // Express 4 keeps the real stack on app._router (app.router is a
  // deprecated getter that THROWS); a bare Router exposes .stack directly.
  const stack = Array.isArray(app.stack) ? app.stack : app._router && app._router.stack;
  return wrapStack(stack);
};

module.exports = installAsyncErrorBoundary;
module.exports.installAsyncErrorBoundary = installAsyncErrorBoundary;
module.exports.wrapStack = wrapStack;
module.exports.wrapHandler = wrapHandler;
