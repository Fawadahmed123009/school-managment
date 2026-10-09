/**
 * Gemini multi-key failover wrapper (utils/geminiClient.js).
 *
 * Locked behaviors (feature spec):
 *   • GEMINI_API_KEYS (comma-separated) with GEMINI_API_KEY as fallback;
 *   • 429 → key cools down (~60s; until next UTC day when the message names
 *     the daily quota) and the next key is tried immediately;
 *   • 503 / overloaded / timeout → one short backoff retry on the SAME key,
 *     then failover;
 *   • 400 → thrown as-is, no rotation (would fail on every key);
 *   • 401/403 → key disabled for the process lifetime, logged loudly, skipped
 *     on every later call;
 *   • round-robin start so load spreads across keys;
 *   • all keys exhausted → one specific error message for the OCR screen;
 *   • key material NEVER appears in logs, thrown messages or responses.
 *
 * The SDK is mocked at construction: the fake client dispatches on the apiKey
 * it was built with, so each test scripts per-key behavior.
 */

const KEY_1 = "SK-failover-key-one-DO-NOT-LEAK";
const KEY_2 = "SK-failover-key-two-DO-NOT-LEAK";
const KEY_3 = "SK-failover-key-three-DO-NOT-LEAK";

// Names start with "mock" so the hoisted jest.mock factory may close over them.
let mockCallLog = []; // apiKey per generateContent call, in order
const mockBehaviors = new Map(); // apiKey -> queue of thunks (result or throw)

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(({ apiKey }) => ({
    models: {
      generateContent: async (params) => {
        mockCallLog.push(apiKey);
        const queue = mockBehaviors.get(apiKey);
        if (queue && queue.length) {
          const outcome = queue.shift();
          return outcome(params);
        }
        return { text: "[]" };
      },
    },
  })),
}));

const mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
jest.mock("../config/logger", () => mockLogger);

const {
  callGemini,
  ALL_KEYS_EXHAUSTED_MESSAGE,
  __resetGeminiPoolForTesting,
  __getPoolStateForTesting,
} = require("../utils/geminiClient");

// ── Helpers ──────────────────────────────────────────────────────────────────

const errWithStatus = (status, message = `status ${status}`) =>
  Object.assign(new Error(message), { status });

const fails = (err) => () => Promise.reject(err);
const wins = (text) => () => ({ text });

const setKeys = (...keys) => {
  process.env.GEMINI_API_KEYS = keys.join(",");
  delete process.env.GEMINI_API_KEY;
};

const behavior = (apiKey, outcomes) => mockBehaviors.set(apiKey, outcomes.slice());

const PARAMS = { model: "gemini-3.6-flash", contents: [{ text: "x" }] };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockCallLog = [];
  mockBehaviors.clear();
  __resetGeminiPoolForTesting();
  setKeys(KEY_1, KEY_2);
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.GEMINI_API_KEYS;
  delete process.env.GEMINI_API_KEY;
});

// ── Config resolution ────────────────────────────────────────────────────────

describe("key configuration", () => {
  test("GEMINI_API_KEYS (comma-separated, whitespace-tolerant) is used", async () => {
    setKeys(" k1 ", "k2", "");
    __resetGeminiPoolForTesting();
    await callGemini(PARAMS);
    expect(mockCallLog).toEqual(["k1"]); // round-robin starts at key 1
  });

  test("falls back to GEMINI_API_KEY when GEMINI_API_KEYS is absent", async () => {
    delete process.env.GEMINI_API_KEYS;
    process.env.GEMINI_API_KEY = KEY_1;
    __resetGeminiPoolForTesting();
    await callGemini(PARAMS);
    expect(mockCallLog).toEqual([KEY_1]);
  });

  test("no key configured → loud error, never an empty/silent success", async () => {
    delete process.env.GEMINI_API_KEYS;
    delete process.env.GEMINI_API_KEY;
    __resetGeminiPoolForTesting();
    await expect(callGemini(PARAMS)).rejects.toThrow(/not configured/i);
    expect(mockCallLog).toHaveLength(0);
  });
});

// ── Round-robin start ────────────────────────────────────────────────────────

describe("round-robin", () => {
  test("consecutive successful calls start from different keys", async () => {
    setKeys(KEY_1, KEY_2, KEY_3);
    await callGemini(PARAMS);
    await callGemini(PARAMS);
    await callGemini(PARAMS);
    await callGemini(PARAMS); // wraps back to key 1
    expect(mockCallLog).toEqual([KEY_1, KEY_2, KEY_3, KEY_1]);
  });
});

// ── 429: cooldown + immediate failover ───────────────────────────────────────

describe("429 rate limit / quota", () => {
  test("429 on key 1 → key 2 is used and the result comes from key 2", async () => {
    behavior(KEY_1, [fails(errWithStatus(429, "Resource has been exhausted (check quota)"))]);
    behavior(KEY_2, [wins('[{"name":"Ali","score":9}]')]);

    const res = await callGemini(PARAMS);
    expect(res.text).toContain("Ali");
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);
  });

  test("429 puts the key in a short (~60s) cooldown by default", async () => {
    behavior(KEY_1, [fails(errWithStatus(429, "rate limit exceeded"))]);
    behavior(KEY_2, [wins("[]")]);

    await callGemini(PARAMS);
    const [k1] = __getPoolStateForTesting();
    const remaining = k1.coolingUntil - Date.now();
    expect(remaining).toBeGreaterThan(30 * 1000);
    expect(remaining).toBeLessThanOrEqual(60 * 1000);
  });

  test("429 naming the DAILY quota cools down until the next day", async () => {
    // Deterministic clock: 2026-10-08 12:00 UTC → 12h until the next day.
    jest.useFakeTimers({ now: Date.UTC(2026, 9, 8, 12, 0, 0) });
    behavior(KEY_1, [fails(errWithStatus(429, "You exceeded your current quota per day"))]);
    behavior(KEY_2, [wins("[]")]);

    await callGemini(PARAMS);
    const [k1] = __getPoolStateForTesting();
    const remaining = k1.coolingUntil - Date.now();
    // Long window — a short (60s) cooldown could never look like this.
    expect(remaining).toBeGreaterThan(6 * 3600 * 1000);
    expect(remaining).toBeLessThan(18 * 3600 * 1000);
  });

  test("a cooled-down key is skipped on later calls until the cooldown passes", async () => {
    behavior(KEY_1, [fails(errWithStatus(429, "rate limit exceeded"))]);
    behavior(KEY_2, [wins("[]"), wins("[]")]);

    await callGemini(PARAMS); // key 1 cools down, key 2 used
    await callGemini(PARAMS); // starts at key 2 (round-robin), key 1 still cooling

    // Advance past the cooldown, then a call starting on key 1 must try it again.
    await jest.advanceTimersByTimeAsync(61 * 1000);
    mockCallLog = [];
    await callGemini(PARAMS); // cursor wraps back to key 1 — no longer cooling
    expect(mockCallLog).toContain(KEY_1);
  });

  test("429 on every key → the specific exhausted error surfaces", async () => {
    behavior(KEY_1, [fails(errWithStatus(429, "quota"))]);
    behavior(KEY_2, [fails(errWithStatus(429, "quota"))]);

    await expect(callGemini(PARAMS)).rejects.toMatchObject({
      message: ALL_KEYS_EXHAUSTED_MESSAGE,
      geminiKeysExhausted: true,
    });
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);

    // Both keys are cooling — a follow-up call fails fast without SDK hits.
    await expect(callGemini(PARAMS)).rejects.toThrow(ALL_KEYS_EXHAUSTED_MESSAGE);
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);
  });
});

// ── 503 / overloaded / timeout: one retry then failover ──────────────────────

describe("503 / transient failures", () => {
  test("503 → one short retry on the SAME key; success avoids failover", async () => {
    behavior(KEY_1, [fails(errWithStatus(503)), wins("[]")]);

    const p = callGemini(PARAMS);
    await jest.advanceTimersByTimeAsync(1000); // backoff
    await p;
    expect(mockCallLog).toEqual([KEY_1, KEY_1]);
  });

  test("503 persisting on key 1 → retry then failover to key 2", async () => {
    behavior(KEY_1, [fails(errWithStatus(503)), fails(errWithStatus(503))]);
    behavior(KEY_2, [wins('[{"name":"Bea","score":7}]')]);

    const p = callGemini(PARAMS);
    await jest.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.text).toContain("Bea");
    expect(mockCallLog).toEqual([KEY_1, KEY_1, KEY_2]);
  });

  test("a network timeout is treated like 503 (retry then failover)", async () => {
    const timeout = Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" });
    behavior(KEY_1, [fails(timeout), fails(timeout)]);
    behavior(KEY_2, [wins("[]")]);

    const p = callGemini(PARAMS);
    await jest.advanceTimersByTimeAsync(1000);
    await p;
    expect(mockCallLog).toEqual([KEY_1, KEY_1, KEY_2]);
  });

  test("'overloaded' message without a status code also retries then fails over", async () => {
    const overloaded = () => new Error("The model is overloaded, please try again later");
    behavior(KEY_1, [fails(overloaded()), fails(overloaded())]);
    behavior(KEY_2, [wins("[]")]);

    const p = callGemini(PARAMS);
    await jest.advanceTimersByTimeAsync(1000);
    await p;
    expect(mockCallLog).toEqual([KEY_1, KEY_1, KEY_2]);
  });
});

// ── 400: no rotation ──────────────────────────────────────────────────────────

describe("400 bad request", () => {
  test("throws immediately — key 2 is never touched", async () => {
    behavior(KEY_1, [fails(errWithStatus(400, "invalid request body"))]);

    await expect(callGemini(PARAMS)).rejects.toThrow("invalid request body");
    expect(mockCallLog).toEqual([KEY_1]); // no rotation
  });

  test("a 400 naming an invalid API key (Google's real bad-key response) DOES rotate", async () => {
    // "API key not valid. Please pass a valid API key." arrives as 400.
    behavior(KEY_1, [fails(errWithStatus(400, "API key not valid. Please pass a valid API key."))]);
    behavior(KEY_2, [wins('[{"name":"Dee","score":8}]')]);

    const res = await callGemini(PARAMS);
    expect(res.text).toContain("Dee");
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);
    const [k1] = __getPoolStateForTesting();
    expect(k1.disabled).toBe(true); // disabled like 401/403, never retried
  });
});

// ── 401/403: disable for process lifetime ────────────────────────────────────

describe("invalid / revoked keys", () => {
  test("401 on key 1 → logged loudly, key 2 used", async () => {
    behavior(KEY_1, [fails(errWithStatus(401, "API key not valid"))]);
    behavior(KEY_2, [wins('[{"name":"Cy","score":5}]')]);

    const res = await callGemini(PARAMS);
    expect(res.text).toContain("Cy");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("INVALID or REVOKED"));
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("key 1/2"));
  });

  test("a disabled key is skipped on ALL later calls (403 variant)", async () => {
    setKeys(KEY_1, KEY_2);
    behavior(KEY_1, [fails(errWithStatus(403, "permission denied"))]);
    behavior(KEY_2, Array(4).fill(wins("[]")));

    await callGemini(PARAMS);
    mockCallLog = [];
    for (let i = 0; i < 4; i++) await callGemini(PARAMS);
    expect(mockCallLog).not.toContain(KEY_1);
    const [k1] = __getPoolStateForTesting();
    expect(k1.disabled).toBe(true);
  });

  test("429 error carrying a string reason (RESOURCE_EXHAUSTED) is still a 429", async () => {
    behavior(KEY_1, [fails(Object.assign(new Error("quota"), { status: "RESOURCE_EXHAUSTED" }))]);
    behavior(KEY_2, [wins("[]")]);
    await callGemini(PARAMS);
    expect(mockCallLog).toEqual([KEY_1, KEY_2]);
    expect(__getPoolStateForTesting()[0].coolingUntil).toBeGreaterThan(Date.now());
  });
});

// ── Key secrecy (spec: never log or return key values) ───────────────────────

describe("key material never leaks", () => {
  test("thrown messages are redacted even when the SDK echoes the key", async () => {
    const leaky = errWithStatus(400, `Request contains an invalid argument for key ${KEY_1}`);
    behavior(KEY_1, [fails(leaky)]);

    await expect(callGemini(PARAMS)).rejects.toBe(leaky);
    expect(leaky.message).not.toContain(KEY_1);
    expect(leaky.message).toContain("«redacted»");
  });

  test("no log call anywhere contains a key value; only positions are logged", async () => {
    behavior(KEY_1, [fails(errWithStatus(429, `quota for ${KEY_1}`))]);
    behavior(KEY_2, [fails(errWithStatus(401, `bad ${KEY_2}`))]);

    await expect(callGemini(PARAMS)).rejects.toThrow(ALL_KEYS_EXHAUSTED_MESSAGE);

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
    behavior(KEY_1, [fails(errWithStatus(429, "quota"))]);
    behavior(KEY_2, [fails(errWithStatus(503, "unavailable")), fails(errWithStatus(503, "unavailable"))]);

    // Handler attached before the timers run — the rejection lands mid-advance.
    const p = callGemini(PARAMS).catch((e) => e);
    await jest.advanceTimersByTimeAsync(1000);
    const err = await p;
    expect(err.message).toBe(ALL_KEYS_EXHAUSTED_MESSAGE);
    expect(err.message).not.toMatch(/SK-failover/);
    expect(err.status).toBe(503);
  });
});
