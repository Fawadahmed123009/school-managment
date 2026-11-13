/**
 * Internal API client used by view routes to call API routes.
 *
 * In production (iisnode / Plesk) the Node process listens on a named pipe,
 * so "http://localhost:PORT" does NOT work.  Set INTERNAL_API_URL to a
 * reachable address, e.g.:
 *   INTERNAL_API_URL=https://avenslms.com/api/v1
 *
 * In development the default falls back to http://localhost:<PORT>/api/v1.
 */
const BASE_URL =
  process.env.INTERNAL_API_URL ||
  `http://localhost:${process.env.PORT || 3001}/api/v1`;

/**
 * A-4: `timeoutMs` is OPT-IN and defaults to no deadline, so the ~100 existing
 * call sites keep byte-identical behaviour. It exists because a view route that
 * awaits a hung internal call never answers the browser at all — the teacher who
 * submits attendance sees the page sit on "Saving…" with no message and no
 * record. Aborting turns that into a normal `{status:"failed"}`, which every
 * calling view route already renders as a readable banner/flash.
 *
 * Phrasing matters: aborting the HTTP request does NOT roll back the API call,
 * which may still be running and may still commit. Timeouts therefore say "could
 * not confirm", never "nothing was saved".
 */
const apiFetch = async (path, token, options = {}) => {
  const { timeoutMs, ...fetchOptions } = options;
  try {
    const init = {
      ...fetchOptions,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(fetchOptions.headers || {}),
      },
    };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      const deadline = AbortSignal.timeout(timeoutMs);
      // Never clobber a signal the caller supplied: compose the two so either
      // one can cancel. (No caller does today, but silently discarding a
      // caller's cancellation would be a new bug introduced by this fix.)
      if (init.signal) {
        // AbortSignal.any needs Node >= 20.3. The host runs a Node 20 venv and
        // its exact minor is not readable from here, so this is capability-
        // checked instead of assumed: with no way to compose, honour the
        // caller's signal and let the request run uncapped (the pre-A-4 shape)
        // rather than throw a TypeError from inside the fix itself.
        init.signal =
          typeof AbortSignal.any === "function"
            ? AbortSignal.any([init.signal, deadline])
            : init.signal;
      } else {
        init.signal = deadline;
      }
    }
    const res = await fetch(`${BASE_URL}${path}`, init);

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return { status: "failed", message: `Unexpected response (${res.status}) from ${path}` };
    }

    const data = await res.json();
    return data;
  } catch (err) {
    // Measured on Node 22 against a socket that accepts but never answers:
    //   AbortSignal.timeout -> err.name === "TimeoutError"
    //   a caller's abort()  -> err.name === "AbortError"
    //   connection refused  -> TypeError "fetch failed" (reason on err.cause)
    // So TimeoutError alone is "we stopped waiting"; an explicit caller abort is
    // a cancellation the caller chose and must not be reported as a server
    // problem, and a refused connection still phrases as a connection failure.
    if (err && err.name === "TimeoutError") {
      return {
        status: "failed",
        message:
          `The server did not respond within ${Math.round(timeoutMs / 1000)}s, so this could not be confirmed. ` +
          "It may still have been saved — reload and check before submitting again.",
      };
    }
    return { status: "failed", message: `Request to ${path} failed: ${err.message}` };
  }
};

module.exports = { apiFetch, BASE_URL };
