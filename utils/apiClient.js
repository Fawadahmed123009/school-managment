const BASE_URL = `http://localhost:${process.env.PORT || 5130}/api/v1`;

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
