/**
 * Tests the Gemini retry logic in marksOcr.service.js (and ocr.service.js).
 *
 * The callGemini helper retries on 503 errors with delays [1000, 3000] ms,
 * up to 2 retries (3 total attempts). Non-retryable errors (e.g. 401) must
 * throw immediately with zero retries.
 *
 * We test via extractMarksFromImageService which calls callGemini internally.
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

jest.mock("../handlers/responseStatus.handler", () =>
  jest.fn((res, code, status, data) => {
    res._statusCode = code;
    res._status = status;
    res._data = data;
    return { statusCode: code, status, data };
  })
);

const { extractMarksFromImageService } = require("../services/academic/marksOcr.service");

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
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Test: 503 twice then success on 3rd attempt ─────────────────────────────

describe("Gemini retry on 503", () => {
  test("retries twice with correct delays then returns the successful result", async () => {
    const successResponse = { text: '[{"name":"Alice","score":85}]' };

    mockGenerateContent
      .mockRejectedValueOnce(errWithStatus(503))  // attempt 1 → 503
      .mockRejectedValueOnce(errWithStatus(503))  // attempt 2 → 503
      .mockResolvedValueOnce(successResponse);     // attempt 3 → success

    const res = makeRes();
    const promise = extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);

    // Advance past the first retry delay (1000ms)
    await jest.advanceTimersByTimeAsync(1000);
    // Advance past the second retry delay (3000ms)
    await jest.advanceTimersByTimeAsync(3000);

    const result = await promise;

    // Should have called generateContent exactly 3 times
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);

    // Should have returned the successful result
    expect(result).toEqual({
      statusCode: 200,
      status: "success",
      data: [{ name: "Alice", score: 85 }],
    });
  });

  test("respects the correct delay schedule: 1000ms then 3000ms", async () => {
    const successResponse = { text: '[{"name":"Bob","score":42}]' };

    mockGenerateContent
      .mockRejectedValueOnce(errWithStatus(503))
      .mockRejectedValueOnce(errWithStatus(503))
      .mockResolvedValueOnce(successResponse);

    const res = makeRes();
    const promise = extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);

    // After 999ms, should still be waiting for 1st retry — generateContent not yet called again
    await jest.advanceTimersByTimeAsync(999);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // At 1000ms, 2nd attempt fires
    await jest.advanceTimersByTimeAsync(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);

    // After another 2999ms (total 3999ms), still waiting for 2nd retry
    await jest.advanceTimersByTimeAsync(2999);
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);

    // At 4000ms total, 3rd attempt fires
    await jest.advanceTimersByTimeAsync(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);

    await promise;
  });
});

// ── Test: 503 exhausts all retries ──────────────────────────────────────────

describe("Gemini retry exhaustion", () => {
  test("throws after 3 consecutive 503s (initial + 2 retries)", async () => {
    mockGenerateContent
      .mockRejectedValueOnce(errWithStatus(503))
      .mockRejectedValueOnce(errWithStatus(503))
      .mockRejectedValueOnce(errWithStatus(503));

    const res = makeRes();
    const promise = extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(3000);

    // The outer catch in extractMarksFromImageService handles 503 and returns a response
    const result = await promise;
    expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    expect(result.statusCode).toBe(503);
  });
});

// ── Test: 401 throws immediately with zero retries ──────────────────────────

describe("Non-retryable error (401)", () => {
  test("throws immediately on 401 with zero retries", async () => {
    mockGenerateContent.mockRejectedValueOnce(errWithStatus(401));

    const res = makeRes();

    // The outer catch re-throws non-503 errors, so this should reject
    await expect(
      extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res)
    ).rejects.toThrow("status 401");

    // Must have been called exactly once — no retries
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  test("does not wait any delay before throwing 401", async () => {
    mockGenerateContent.mockRejectedValueOnce(errWithStatus(401));

    const res = makeRes();
    const promise = extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res);

    // Should reject without needing to advance timers at all
    await expect(promise).rejects.toThrow("status 401");
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });
});

// ── Test: Other non-503 errors also throw immediately ────────────────────────

describe("Other non-retryable errors", () => {
  test("throws immediately on 400 error with zero retries", async () => {
    mockGenerateContent.mockRejectedValueOnce(errWithStatus(400));

    const res = makeRes();
    await expect(
      extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res)
    ).rejects.toThrow("status 400");

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  test("throws immediately on 403 error with zero retries", async () => {
    mockGenerateContent.mockRejectedValueOnce(errWithStatus(403));

    const res = makeRes();
    await expect(
      extractMarksFromImageService("/fake/path.jpg", "image/jpeg", res)
    ).rejects.toThrow("status 403");

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });
});

// ── Test: Success on first attempt (no retries needed) ──────────────────────

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
});
