/**
 * OpenRouter multi-key failover wrapper (utils/openRouterClient.js).
 *
 * Locked behaviors (carried over from the Gemini wrapper spec, mapped to
 * OpenRouter's OpenAI-compatible chat completions API):
 *   • OPENROUTER_API_KEYS (comma-separated) with OPENROUTER_API_KEY fallback;
 *   • 429 → key cools down (~60s; until next UTC day when the message names
 *     the daily free-model quota or X-RateLimit-Reset points further out)
 *     and the next key is tried immediately;
 *   • 402 (credits blocked) → cool down until the next UTC day, then rotate;
 *   • 5xx / overloaded / timeout → one short backoff retry on the SAME key,
 *     then failover;
 *   • 400 → thrown as-is, no rotation (would fail on every key);
 *   • 401/403 → key disabled for the process lifetime, logged loudly, skipped
 *     on every later call;
 *   • round-robin start so load spreads across keys;
 *   • all keys exhausted → one specific error message for the OCR screen;
 *   • key material NEVER appears in logs, thrown messages or responses;
 *   • request payload is OpenRouter chat format with the free-tier Nemotron
 *     VL model and the scan as a data-URL image part; reply normalized to
 *     { text } so OCR parsing stays unchanged.
 *
 * The HTTP transport is mocked via __setTransportForTesting: the fake
 * dispatches on the Bearer key it receives, so each test scripts per-key
 * behavior.
 */

const KEY_1 = "sk-or-failover-key-one-DO-NOT-LEAK";
const KEY_2 = "sk-or-failover-key-two-DO-NOT-LEAK";
const KEY_3 = "sk-or-failover-key-three-DO-NOT-LEAK";

// Names start with "mock" so the hoisted jest.mock factory may close over them.
let mockCallLog = []; // Bearer key per transport call, in order
let mockRequests = []; // full transport request objects, in order
const mockBehaviors = new Map(); // key -> queue of thunks (response or throw)

const mockTransport = async (request) => {
  const key = String(request.headers.Authorization || "").replace(/^Bearer /, "");
  mockCallLog.push(key);
  mockRequests.push(request);
  const queue = mockBehaviors.get(key);
  if (queue && queue.length) {
    const outcome = queue.shift();
    return outcome(request);
  }
  return okResponse("[]");
};

const mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock("../config/logger", () => mockLogger);

const {
  callOpenRouter,
  DEFAULT_MODEL,
  ALL_KEYS_EXHAUSTED_MESSAGE,
  __resetOpenRouterPoolForTesting,
  __getPoolStateForTesting,
  __setTransportForTesting,
} = require("../utils/openRouterClient");

// ── Helpers ──────────────────────────────────────────────────────────────────

const okResponse = (text) => ({
  status: 200,
  headers: {},
  body: JSON.stringify({ choices: [{ message: { content: text } }] }),
});

const errResponse = (status, message = `status ${status}`, headers = {}) => ({
  status,
  headers,
  body: JSON.stringify({ error: { code: status, message } }),
});

const fails = (response) => () => response;
const wins = (text) => () => okResponse(text);

const setKeys = (...keys) => {
  process.env.OPENROUTER_API_KEYS = keys.join(",");
  delete process.env.OPENROUTER_API_KEY;
};

const behavior = (key, outcomes) => mockBehaviors.set(key, outcomes.slice());

const PARAMS = { prompt: "read the sheet", mimeType: "image/jpeg", imageData: "aW1hZ2U=" };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockCallLog = [];
  mockRequests = [];
  mockBehaviors.clear();
  __resetOpenRouterPoolForTesting();
  __setTransportForTesting(mockTransport);
  setKeys(KEY_1, KEY_2);
});

afterEach(() => {
  jest.useRealTimers();
  __setTransportForTesting(null);
  delete process.env.OPENROUTER_API_KEYS;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
});

// ── Config resolution ────────────────────────────────────────────────────────

describe("key configuration", () => {
  test("OPENROUTER_API_KEYS (comma-separated, whitespace-tolerant) is used", async () => {
    setKeys(" k1 ", "k2", "");
    __resetOpenRouterPoolForTesting();
    await callOpenRouter(PARAMS);
    expect(mockCallLog).toEqual(["k1"]); // round-robin starts at key 1
  });

  test("falls back to OPENROUTER_API_KEY when OPENROUTER_API_KEYS is absent", async () => {
    delete process.env.OPENROUTER_API_KEYS;
    process.env.OPENROUTER_API_KEY = KEY_1;
    __resetOpenRouterPoolForTesting();
    await callOpenRouter(PARAMS);
    expect(mockCallLog).toEqual([KEY_1]);
  });

  test("no key configured → loud error, never an empty/silent success", async () => {
    delete process.env.OPENROUTER_API_KEYS;
    delete process.env.OPENROUTER_API_KEY;
    __resetOpenRouterPoolForTesting();
    await expect(callOpenRouter(PARAMS)).rejects.toThrow(/not configured/i);
    expect(mockCallLog).toHaveLength(0);
  });
});

// ── Request payload (OpenRouter chat completions format) ────────────────────

describe("OpenRouter request payload", () => {
  test("posts chat completions with the free-tier Nemotron VL model and a data-URL image", async () => {
    await callOpenRouter(PARAMS);
    const req = mockRequests[0];
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe(`Bearer ${KEY_1}`);
    expect(req.headers["Content-Type"]).toBe("application/json");

    const payload = JSON.parse(req.body);
    expect(payload.model).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(payload.model).toBe(DEFAULT_MODEL);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].role).toBe("user");
    expect(payload.messages[0].content).toEqual([
      { type: "text", text: PARAMS.prompt },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,aW1hZ2U=" } },
    ]);
  });

  test("OPENROUTER_MODEL env override is honored", async () => {
    process.env.OPENROUTER_MODEL = "nvidia/nemotron-3.5-super-vl:free";
    await callOpenRouter({ ...PARAMS, model: "custom/model:free" });
    expect(JSON.parse(mockRequests[0].body).model).toBe("custom/model:free");
  });

  test("the reply is normalized to { text } from choices[0].message.content", async () => {
    behavior(KEY_1, [wins('[{"name":"Ali","score":9}]')]);
    const res = await callOpenRouter(PARAMS);
    expect(res).toEqual({ text: '[{"name":"Ali","score":9}]' });
  });

  test("an empty completion throws loudly instead of looking like a clean scan", async () => {
    behavior(KEY_1, [fails(okResponse(""))]);
    await expect(callOpenRouter(PARAMS)).rejects.toThrow(/empty completion/i);
  });
});

// ── Round-robin start ────────────────────────────────────────────────────────

describe("round-robin", () => {
  test("consecutive successful calls start from different keys", async () => {
    setKeys(KEY_1, KEY_2, KEY_3);
    await callOpenRouter(PARAMS);
    await callOpenRouter(PARAMS);
    await callOpenRouter(PARAMS);
    await callOpenRouter(PARAMS); // wraps back to key 1
    expect(mockCallLog).toEqual([KEY_1, KEY_2, KEY_3, KEY_1]);
  });
});

// ── 429: cooldown + immediate failover ───────────────────────────────────────

describe("429 rate limit / quota", () => {
  test("429 on key 1 → key 2 is used and the result comes from key 2", async () => {
    behavior(KEY_1, [fails(errResponse(429, "Rate limit exceeded"))]);
    behavior(KEY_2, [wins('[{"name":"Ali","score":9}]')]);

    const res = await callOpenRouter(PARAMS);
    expect(res.text).toContain("Ali");
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);
  });

  test("429 puts the key in a short (~60s) cooldown by default", async () => {
    behavior(KEY_1, [fails(errResponse(429, "rate limit exceeded"))]);
    behavior(KEY_2, [wins("[]")]);

    await callOpenRouter(PARAMS);
    const [k1] = __getPoolStateForTesting();
    const remaining = k1.coolingUntil - Date.now();
    expect(remaining).toBeGreaterThan(30 * 1000);
    expect(remaining).toBeLessThanOrEqual(60 * 1000);
  });

  test("429 naming the DAILY free-model quota cools down until the next day", async () => {
    // Deterministic clock: 2026-10-08 12:00 UTC → 12h until the next day.
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 8, 12, 0, 0) });
    behavior(KEY_1, [fails(errResponse(429, "Free model daily request limit exceeded"))]);
    behavior(KEY_2, [wins("[]")]);

    await callOpenRouter(PARAMS);
    const [k1] = __getPoolStateForTesting();
    const remaining = k1.coolingUntil - Date.now();
    // Long window — a short (60s) cooldown could never look like this.
    expect(remaining).toBeGreaterThan(6 * 3600 * 1000);
    expect(remaining).toBeLessThan(18 * 3600 * 1000);
  });

  test("429 with X-RateLimit-Reset cools down until the header's reset time", async () => {
    const resetAt = Date.now() + 3 * 3600 * 1000; // 3h out — daily window
    behavior(KEY_1, [fails(errResponse(429, "Rate limit exceeded", { "x-ratelimit-reset": String(resetAt) }))]);
    behavior(KEY_2, [wins("[]")]);

    await callOpenRouter(PARAMS);
    const [k1] = __getPoolStateForTesting();
    expect(k1.coolingUntil).toBe(resetAt);
  });

  test("a cooled-down key is skipped on later calls until the cooldown passes", async () => {
    behavior(KEY_1, [fails(errResponse(429, "rate limit exceeded"))]);
    behavior(KEY_2, [wins("[]"), wins("[]")]);

    await callOpenRouter(PARAMS); // key 1 cools down, key 2 used
    await callOpenRouter(PARAMS); // starts at key 2 (round-robin), key 1 still cooling

    // Advance past the cooldown, then a call starting on key 1 must try it again.
    await jest.advanceTimersByTimeAsync(61 * 1000);
    mockCallLog = [];
    await callOpenRouter(PARAMS); // cursor wraps back to key 1 — no longer cooling
    expect(mockCallLog).toContain(KEY_1);
  });

  test("429 on every key → the specific exhausted error surfaces", async () => {
    behavior(KEY_1, [fails(errResponse(429, "quota"))]);
    behavior(KEY_2, [fails(errResponse(429, "quota"))]);

    await expect(callOpenRouter(PARAMS)).rejects.toMatchObject({
      message: ALL_KEYS_EXHAUSTED_MESSAGE,
      geminiKeysExhausted: true,
    });
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);

    // Both keys are cooling — a follow-up call fails fast without HTTP hits.
    await expect(callOpenRouter(PARAMS)).rejects.toThrow(ALL_KEYS_EXHAUSTED_MESSAGE);
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);
  });
});

// ── 402: credits blocked → daily cooldown then failover ─────────────────────

describe("402 credits blocked", () => {
  test("402 cools the key until the next day and fails over", async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 8, 12, 0, 0) });
    behavior(KEY_1, [fails(errResponse(402, "Insufficient credits"))]);
    behavior(KEY_2, [wins("[]")]);

    const res = await callOpenRouter(PARAMS);
    expect(res.text).toBe("[]");
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);
    const [k1] = __getPoolStateForTesting();
    expect(k1.coolingUntil - Date.now()).toBeGreaterThan(6 * 3600 * 1000);
  });
});

// ── 5xx / overloaded / timeout: one retry then failover ─────────────────────

describe("503 / transient failures", () => {
  test("503 → one short retry on the SAME key; success avoids failover", async () => {
    behavior(KEY_1, [fails(errResponse(503)), wins("[]")]);

    const p = callOpenRouter(PARAMS);
    await jest.advanceTimersByTimeAsync(1000); // backoff
    await p;
    expect(mockCallLog).toEqual([KEY_1, KEY_1]);
  });

  test("503 persisting on key 1 → retry then failover to key 2", async () => {
    behavior(KEY_1, [fails(errResponse(503)), fails(errResponse(503))]);
    behavior(KEY_2, [wins('[{"name":"Bea","score":7}]')]);

    const p = callOpenRouter(PARAMS);
    await jest.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.text).toContain("Bea");
    expect(mockCallLog).toEqual([KEY_1, KEY_1, KEY_2]);
  });

  test("a network timeout is treated like 503 (retry then failover)", async () => {
    const timeout = Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" });
    behavior(KEY_1, [() => Promise.reject(timeout), () => Promise.reject(timeout)]);
    behavior(KEY_2, [wins("[]")]);

    const p = callOpenRouter(PARAMS);
    await jest.advanceTimersByTimeAsync(1000);
    await p;
    expect(mockCallLog).toEqual([KEY_1, KEY_1, KEY_2]);
  });

  test("our own fetch abort (request timeout) retries then fails over", async () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    behavior(KEY_1, [() => Promise.reject(abort), () => Promise.reject(abort)]);
    behavior(KEY_2, [wins("[]")]);

    const p = callOpenRouter(PARAMS);
    await jest.advanceTimersByTimeAsync(1000);
    await p;
    expect(mockCallLog).toEqual([KEY_1, KEY_1, KEY_2]);
  });

  test("'overloaded' message without a status code also retries then fails over", async () => {
    const overloaded = () => Promise.reject(new Error("The model is overloaded, please try again later"));
    behavior(KEY_1, [overloaded, overloaded]);
    behavior(KEY_2, [wins("[]")]);

    const p = callOpenRouter(PARAMS);
    await jest.advanceTimersByTimeAsync(1000);
    await p;
    expect(mockCallLog).toEqual([KEY_1, KEY_1, KEY_2]);
  });
});

// ── 400: no rotation ──────────────────────────────────────────────────────────

describe("400 bad request", () => {
  test("throws immediately — key 2 is never touched", async () => {
    behavior(KEY_1, [fails(errResponse(400, "invalid request body"))]);

    await expect(callOpenRouter(PARAMS)).rejects.toThrow("invalid request body");
    expect(mockCallLog).toEqual([KEY_1]); // no rotation
  });

  test("a 400 naming an invalid API key DOES rotate (defensive carry-over)", async () => {
    behavior(KEY_1, [fails(errResponse(400, "API key not valid. Please pass a valid API key."))]);
    behavior(KEY_2, [wins('[{"name":"Dee","score":8}]')]);

    const res = await callOpenRouter(PARAMS);
    expect(res.text).toContain("Dee");
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);
    const [k1] = __getPoolStateForTesting();
    expect(k1.disabled).toBe(true); // disabled like 401/403, never retried
  });
});

// ── 401/403: disable for process lifetime ────────────────────────────────────

describe("invalid / revoked keys", () => {
  test("401 on key 1 → logged loudly, key 2 used", async () => {
    behavior(KEY_1, [fails(errResponse(401, "User not found"))]);
    behavior(KEY_2, [wins('[{"name":"Cy","score":5}]')]);

    const res = await callOpenRouter(PARAMS);
    expect(res.text).toContain("Cy");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("INVALID or REVOKED"));
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("key 1/2"));
  });

  test("a disabled key is skipped on ALL later calls (403 variant)", async () => {
    setKeys(KEY_1, KEY_2);
    behavior(KEY_1, [fails(errResponse(403, "permission denied"))]);
    behavior(KEY_2, Array(4).fill(wins("[]")));

    await callOpenRouter(PARAMS);
    mockCallLog = [];
    for (let i = 0; i < 4; i++) await callOpenRouter(PARAMS);
    expect(mockCallLog).not.toContain(KEY_1);
    const [k1] = __getPoolStateForTesting();
    expect(k1.disabled).toBe(true);
  });
});

// ── Key secrecy (spec: never log or return key values) ───────────────────────

describe("key material never leaks", () => {
  test("thrown messages are redacted even when the provider echoes the key", async () => {
    const leaky = errResponse(400, `Request contains an invalid argument for key ${KEY_1}`);
    behavior(KEY_1, [fails(leaky)]);

    await expect(callOpenRouter(PARAMS)).rejects.toThrow(/«redacted»/);
    expect(mockRequests).toHaveLength(1);
  });

  test("no log call anywhere contains a key value; only positions are logged", async () => {
    behavior(KEY_1, [fails(errResponse(429, `quota for ${KEY_1}`))]);
    behavior(KEY_2, [fails(errResponse(401, `bad ${KEY_2}`))]);

    await expect(callOpenRouter(PARAMS)).rejects.toThrow(ALL_KEYS_EXHAUSTED_MESSAGE);

    const everyLoggedArg = [...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls]
      .flat()
      .filter((a) => typeof a === "string")
      .join("\n");
    expect(everyLoggedArg).not.toContain(KEY_1);
    expect(everyLoggedArg).not.toContain(KEY_2);
    expect(everyLoggedArg).toContain("key 1/2");
    expect(everyLoggedArg).toContain("key 2/2");
  });

  test("the exhausted error message itself contains no key and is specific", async () => {
    behavior(KEY_1, [fails(errResponse(429, "quota"))]);
    behavior(KEY_2, [fails(errResponse(503, "unavailable")), fails(errResponse(503, "unavailable"))]);

    // Handler attached before the timers run — the rejection lands mid-advance.
    const p = callOpenRouter(PARAMS).catch((e) => e);
    await jest.advanceTimersByTimeAsync(1000);
    const err = await p;
    expect(err.message).toBe(ALL_KEYS_EXHAUSTED_MESSAGE);
    expect(err.message).not.toMatch(/sk-or-failover/);
    expect(err.status).toBe(503);
  });
});