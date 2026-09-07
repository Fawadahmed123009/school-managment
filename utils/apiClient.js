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

const apiFetch = async (path, token, options = {}) => {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return { status: "failed", message: `Unexpected response (${res.status}) from ${path}` };
    }

    const data = await res.json();
    return data;
  } catch (err) {
    return { status: "failed", message: `Request to ${path} failed: ${err.message}` };
  }
};

module.exports = { apiFetch, BASE_URL };
