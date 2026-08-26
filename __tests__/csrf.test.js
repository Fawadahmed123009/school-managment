/**
 * Tests for the CSRF protection middleware (middlewares/csrf.js).
 *
 * The token is a synchronizer token bound to the session JWT:
 *   csrfToken = base64url( HMAC-SHA256(JWT_SECRET_KEY, sessionToken) )
 *
 * Verifies:
 *   • generateCsrfToken is deterministic, session-bound, and empty without a token.
 *   • attachCsrfToken exposes the token on res.locals.
 *   • verifyCsrf: valid token via header → next(); valid token via body._csrf → next();
 *     missing token → 403 (next not called); tampered token → 403; token bound to a
 *     DIFFERENT session → 403; safe methods (GET/HEAD/OPTIONS) → next() with no token.
 */

// Must be set before the middleware computes any HMAC (it reads this at call time).
process.env.JWT_SECRET_KEY = "test-secret-key-for-csrf-suite";

const { generateCsrfToken, attachCsrfToken, verifyCsrf } = require("../middlewares/csrf");

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.locals = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.render = jest.fn().mockReturnValue(res);
  return res;
}

// Mirrors the parts of an Express request the middleware touches: a
// case-insensitive .get() for headers, plus method/body/token/xhr.
function mockReq({ method = "POST", headers = {}, body = {}, token = undefined, xhr = false } = {}) {
  const lowered = {};
  Object.keys(headers).forEach((k) => {
    lowered[k.toLowerCase()] = headers[k];
  });
  return {
    method,
    body,
    token,
    xhr,
    get(name) {
      return lowered[String(name).toLowerCase()];
    },
  };
}

const SESSION_A = "session-jwt-aaa.payload.sig";
const SESSION_B = "session-jwt-bbb.payload.sig";

// ── generateCsrfToken ─────────────────────────────────────────────────────────

describe("generateCsrfToken", () => {
  test("is deterministic for the same session token", () => {
    expect(generateCsrfToken(SESSION_A)).toBe(generateCsrfToken(SESSION_A));
  });

  test("differs for different session tokens (binding)", () => {
    expect(generateCsrfToken(SESSION_A)).not.toBe(generateCsrfToken(SESSION_B));
  });

  test("returns empty string when no session token is present", () => {
    expect(generateCsrfToken(undefined)).toBe("");
    expect(generateCsrfToken("")).toBe("");
    expect(generateCsrfToken(null)).toBe("");
  });

  test("produces a url-safe base64 string (no +, /, or = padding)", () => {
    const token = generateCsrfToken(SESSION_A);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ── attachCsrfToken ───────────────────────────────────────────────────────────

describe("attachCsrfToken", () => {
  test("sets res.locals.csrfToken to the session's token and calls next", () => {
    const req = mockReq({ token: SESSION_A });
    const res = mockRes();
    const next = jest.fn();

    attachCsrfToken(req, res, next);

    expect(res.locals.csrfToken).toBe(generateCsrfToken(SESSION_A));
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("sets an empty token when there is no session (e.g. pre-login pages)", () => {
    const req = mockReq({ token: undefined });
    const res = mockRes();
    const next = jest.fn();

    attachCsrfToken(req, res, next);

    expect(res.locals.csrfToken).toBe("");
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ── verifyCsrf ────────────────────────────────────────────────────────────────

describe("verifyCsrf", () => {
  test("ALLOWS when a valid token arrives in the X-CSRF-Token header", () => {
    const token = generateCsrfToken(SESSION_A);
    const req = mockReq({ token: SESSION_A, headers: { "X-CSRF-Token": token } });
    const res = mockRes();
    const next = jest.fn();

    verifyCsrf(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("ALLOWS when a valid token arrives in the _csrf body field", () => {
    const token = generateCsrfToken(SESSION_A);
    const req = mockReq({ token: SESSION_A, body: { _csrf: token, name: "Class 9" } });
    const res = mockRes();
    const next = jest.fn();

    verifyCsrf(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("REJECTS with 403 when no token is provided", () => {
    const req = mockReq({ token: SESSION_A, body: {} });
    const res = mockRes();
    const next = jest.fn();

    verifyCsrf(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("REJECTS with 403 when the token is tampered", () => {
    const token = generateCsrfToken(SESSION_A);
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const req = mockReq({ token: SESSION_A, headers: { "X-CSRF-Token": tampered } });
    const res = mockRes();
    const next = jest.fn();

    verifyCsrf(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("REJECTS with 403 when the token is bound to a DIFFERENT session", () => {
    // Token minted for session B, but this request is authenticated as session A.
    const foreignToken = generateCsrfToken(SESSION_B);
    const req = mockReq({ token: SESSION_A, headers: { "X-CSRF-Token": foreignToken } });
    const res = mockRes();
    const next = jest.fn();

    verifyCsrf(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("REJECTS with 403 when a token is supplied but the request has no session", () => {
    const req = mockReq({ token: undefined, headers: { "X-CSRF-Token": "anything" } });
    const res = mockRes();
    const next = jest.fn();

    verifyCsrf(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("returns a JSON error for AJAX/JSON requests", () => {
    const req = mockReq({
      token: SESSION_A,
      headers: { "content-type": "application/json" },
      body: {},
    });
    const res = mockRes();
    const next = jest.fn();

    verifyCsrf(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/csrf/i);
    expect(res.render).not.toHaveBeenCalled();
  });

  test("renders an error page for normal (non-AJAX) form requests", () => {
    const req = mockReq({ token: SESSION_A, body: {} });
    const res = mockRes();
    const next = jest.fn();

    verifyCsrf(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.render).toHaveBeenCalledTimes(1);
    expect(res.render.mock.calls[0][0]).toBe("error");
    expect(res.json).not.toHaveBeenCalled();
  });

  test.each(["GET", "HEAD", "OPTIONS"])(
    "ALLOWS safe method %s through without any token",
    (method) => {
      const req = mockReq({ method, token: SESSION_A, body: {} });
      const res = mockRes();
      const next = jest.fn();

      verifyCsrf(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  );
});
