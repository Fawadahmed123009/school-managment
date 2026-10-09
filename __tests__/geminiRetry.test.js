/**
 * Service-level Gemini failover behavior (marksOcr.service via utils/geminiClient).
 *
 * The wrapper owns retry/failover: a transient (503) failure gets ONE short
 * backoff retry (1000ms) on the same key, and when no key can complete the
 * request the service must answer 503 with the specific quota/busy message —
 * never an empty result. 400 (bad request) is not rotated and propagates to
 * the controller unchanged.
 *
 * Single-key pool here (legacy GEMINI_API_KEY fallback); multi-key rotation is
 * covered in geminiFailover.test.js.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockGenerateContent = jest.fn();

jest.mock("@google/genai", () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: { generateContent: (...args) => mockGenerateContent(...args) },
    })),
  };
});

jest.mock("fs", () => ({
  readFileSync: jest.fn().mockReturnValue("base64imagedata"),
  unlink: jest.fn((_path, cb) => { if (typeof cb === "function") cb(); }),
}));

// The failover wrapper logs through the shared winston logger — keep it mocked
// so no log files (or real fs) are touched by this suite.
const mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock("../config/logger", () => mockLogger);

jest.mock("../handlers/responseStatus.handler", () =>
  jest.fn((res, code, status, data) => {
    res._statusCode = code;
    res._status = status;
    res._data = data;
    return { statusCode: code, status, data };
  })
);

const { extractMarksFromImageService } = require("../services/academic/marksOcr.service");
const { ALL_KEYS_EXHAUSTED_MESSAGE, __resetGeminiPoolForTesting } = require("../utils/geminiClient");

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnThis();
  res.json = jest.fn().mockReturnThis();
  return res;
};

const errWithStatus = (status) => {
  const e = new Error(`status ${status}`);
  e.status = status;
  return e;
};

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  // Single legacy key — also proves GEMINI_API_KEY still works as a fallback.
  delete process.env.GEMINI_API_KEYS;
  process.env.GEMINI_API_KEY = "retry-test-key";
  __resetGeminiPoolForTesting();
});

afterEach(() => {
  jest.useRealTimers();
});

// ── 503: one short retry on the same key ─────────────────────────────────────

describe("503 retry then failover", () => {
  test("503 on the first attempt succeeds after one 1000ms backoff retry", async () => {
    const successResponse = { text: '[{"name":"Alice","score":85}]' };

    mockGenerateContent
      .mockRejectedValueOnce(errWithStatus(503))  // attempt 1 → 503
      .mockResolvedValueOnce(successResponse);     // retry → success

    const res = makeRes();
    const promise = extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);

    // Backoff fires exactly at 1000ms
    await jest.advanceTimersByTimeAsync(999);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);

    const result = await promise;
    expect(result).toEqual({
      statusCode: 200,
      status: "success",
      data: [{ name: "Alice", score: 85 }],
    });
  });

  test("persistent 503 → one retry, then the 503 response carries the specific message", async () => {
    mockGenerateContent.mockRejectedValue(errWithStatus(503));

    const res = makeRes();
    const promise = extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);
    await jest.advanceTimersByTimeAsync(1000);

    const result = await promise;
    // Initial attempt + ONE retry (no more, no key left to rotate to)
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(result.statusCode).toBe(503);
    expect(result.data).toBe(ALL_KEYS_EXHAUSTED_MESSAGE);
  });
});

// ── 429: cooldown, then (single key) exhausted ───────────────────────────────

describe("429 quota", () => {
  test("429 with a single key → clear quota/busy 503 response, not a throw", async () => {
    mockGenerateContent.mockRejectedValue(Object.assign(new Error("quota exceeded"), { status: 429 }));

    const res = makeRes();
    const result = await extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1); // cooled down, no same-key retry
    expect(result.statusCode).toBe(503);
    expect(result.data).toBe(ALL_KEYS_EXHAUSTED_MESSAGE);
  });
});

// ── 401/403: key disabled → exhausted on the last key ────────────────────────

describe("invalid key (401/403)", () => {
  test.each([401, 403])("%i disables the key — caller gets the 503 quota/busy message", async (status) => {
    mockGenerateContent.mockRejectedValue(errWithStatus(status));

    const res = makeRes();
    const result = await extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(503);
    expect(result.data).toBe(ALL_KEYS_EXHAUSTED_MESSAGE);

    // Disabled for the process lifetime — a second upload never touches it.
    mockGenerateContent.mockClear();
    const res2 = makeRes();
    const result2 = await extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res2);
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(result2.statusCode).toBe(503);
  });
});

// ── 400: no rotation, error propagates unchanged to the controller ───────────

describe("400 bad request", () => {
  test("throws immediately with zero retries", async () => {
    mockGenerateContent.mockRejectedValueOnce(errWithStatus(400));

    const res = makeRes();
    await expect(
      extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res)
    ).rejects.toThrow("status 400");

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });
});

// ── Success on first attempt (no retries needed) ──────────────────────────────

describe("Success on first attempt", () => {
  test("returns result immediately without retries", async () => {
    const successResponse = { text: '[{"name":"Carol","score":99}]' };
    mockGenerateContent.mockResolvedValueOnce(successResponse);

    const res = makeRes();
    const result = await extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      statusCode: 200,
      status: "success",
      data: [{ name: "Carol", score: 99 }],
    });
  });

  test("the exhausted message never contains the configured key", async () => {
    mockGenerateContent.mockRejectedValue(errWithStatus(429));
    const res = makeRes();
    const result = await extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);
    expect(String(result.data)).not.toContain("retry-test-key");
  });
});
