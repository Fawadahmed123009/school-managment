/**
 * Shared Gemini API wrapper with multi-key failover.
 *
 * Every Gemini call in the app (marks OCR, fees OCR, future features) goes
 * through callGemini() below — failover/cooldown logic lives here only, never
 * duplicated per service.
 *
 * Configuration:
 *   GEMINI_API_KEYS  comma-separated list (used first, if present)
 *   GEMINI_API_KEY   legacy single key — kept working as a fallback
 *
 * Failover rules (per spec):
 *   429  → mark the key cooling down (~60s per-minute limit; until next UTC
 *          day when the error text indicates the DAILY quota is exhausted)
 *          and immediately try the next key.
 *   503 / overloaded / timeout → one short retry with backoff on the SAME key,
 *          then move to the next key.
 *   400  → do NOT rotate (it would fail identically on every key) — throw.
 *          Exception: a 400 whose text names an invalid API key (what Google
 *          actually returns for bad keys) is treated as the 401/403 case below.
 *   401 / 403 → mark the key disabled for the process lifetime, log loudly,
 *          move on.
 *   Any other error → throw unchanged (don't guess at unfamiliar failures).
 *
 * Keys are never logged or returned — only their position ("key 2/3"). Error
 * messages leaving this module are redacted for any configured key string.
 *
 * State is in-memory (cooldown timestamps, disabled flags, round-robin cursor).
 * Callers: utils/geminiClient.callGemini(params) → Gemini generateContent
 * response, or throws. When every usable key is exhausted the thrown error
 * carries geminiKeysExhausted=true and ALL_KEYS_EXHAUSTED_MESSAGE, which OCR
 * services surface to the UI as a 503 with that message.
 */
const { GoogleGenAI } = require("@google/genai");
const logger = require("../config/logger");

const ALL_KEYS_EXHAUSTED_MESSAGE = "OCR quota reached or service busy — try again in a minute";

const SHORT_COOLDOWN_MS = 60 * 1000; // per-minute rate limits
const TRANSIENT_RETRY_BACKOFF_MS = 1000; // one short retry before failing over
const TRANSIENT_RETRIES = 1; // same-key attempts after the first (503/timeout)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Lazily built from env so tests (and rotated .env values) take effect without
// a reload of the whole module graph.
let pool = null; // [{ key, client, disabled, coolingUntil }]
let roundRobinCursor = 0;

const resolveKeys = () => {
  const multi = String(process.env.GEMINI_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const single = String(process.env.GEMINI_API_KEY || "").trim();
  return single ? [single] : [];
};

const getPool = () => {
  const keys = resolveKeys();
  // Rebuild if the configured key set changed (env reload) — positions and
  // cooldowns reset, which is correct when the keys themselves change.
  const current = pool && pool.map((s) => s.key);
  if (!pool || current.length !== keys.length || current.some((k, i) => k !== keys[i])) {
    pool = keys.map((key) => ({
      key,
      client: new GoogleGenAI({ apiKey: key }),
      disabled: false,
      coolingUntil: 0,
    }));
    roundRobinCursor = 0;
  }
  return pool;
};

// Replace any configured key occurrence — a third-party error message should
// never carry a secret into logs or HTTP responses even though it can't.
const redactKeys = (text) => {
  if (typeof text !== "string" || !pool) return text;
  return pool.reduce((acc, slot) => acc.split(slot.key).join("«redacted»"), text);
};

// gRPC-style reason strings some Google API clients surface instead of numbers.
const STATUS_BY_REASON = {
  INVALID_ARGUMENT: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  RESOURCE_EXHAUSTED: 429,
  UNAVAILABLE: 503,
};

const httpStatusOf = (err) => {
  if (typeof err?.status === "number") return err.status;
  if (typeof err?.status === "string" && STATUS_BY_REASON[err.status.toUpperCase()]) {
    return STATUS_BY_REASON[err.status.toUpperCase()];
  }
  // Some SDK versions nest the HTTP code under .code / .response
  const code = typeof err?.code === "number" ? err.code : undefined;
  return code;
};

const TRANSIENT_CODES = ["ETIMEDOUT", "ECONNABORTED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE"];

const isTransient = (err, status) => {
  if (status === 503 || status === 500 || status === 502 || status === 504) return true;
  const msg = String(err?.message || "").toLowerCase();
  if (TRANSIENT_CODES.includes(err?.code)) return true;
  return /overload|unavailable|timeout|timed out|socket hang up/.test(msg);
};

// 429 covers both per-minute rate limits and daily quota exhaustion. Google's
// messages name the window when it is the daily one; anything ambiguous gets
// the short cooldown and is retried sooner (spec: prefer the short window).
const isDailyQuota = (err) => {
  const msg = String(err?.message || "");
  return /per\s*day|daily|per-day|\bday\b.{0,40}quota|quota.{0,40}\bday\b/i.test(msg);
};

// Google answers a bad/revoked API key with 400 INVALID_ARGUMENT ("API key not
// valid") rather than 401/403. Such a 400 is an invalid-key signal (disable and
// rotate); a genuine bad-request 400 still must not rotate. Only the key-worded
// text distinguishes them.
const isInvalidKey400 = (err) => {
  const msg = String(err?.message || "");
  return /api[ _.-]?key/i.test(msg) && /not valid|invalid|revoked|expired|deactivated|disabled/i.test(msg);
};

const msUntilNextUtcDay = () => {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 1);
  return next - now.getTime();
};

/**
 * Call Gemini generateContent with key failover. Returns the SDK response
 * (with .text) or throws:
 *  - the original error for 400 / unknown failures (message redacted),
 *  - an Error with geminiKeysExhausted=true + ALL_KEYS_EXHAUSTED_MESSAGE when
 *    no usable key could complete the request.
 */
const callGemini = async (params) => {
  const slots = getPool();
  if (!slots.length) {
    // Fail loudly — an empty result here would look like a successful scan.
    throw new Error("OCR is not configured: no Gemini API key found (set GEMINI_API_KEYS or GEMINI_API_KEY)");
  }

  const total = slots.length;
  const start = roundRobinCursor;
  roundRobinCursor = (start + 1) % total; // spread load across keys per call

  for (let step = 0; step < total; step++) {
    const idx = (start + step) % total;
    const slot = slots[idx];
    const pos = `${idx + 1}/${total}`;

    if (slot.disabled) continue;
    if (slot.coolingUntil > Date.now()) continue;

    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
      let err;
      try {
        return await slot.client.models.generateContent(params);
      } catch (e) {
        err = e;
      }

      const status = httpStatusOf(err);
      const errText = redactKeys(String(err?.message || err));

      if (status === 400 && !isInvalidKey400(err)) {
        // Bad request fails on every key — rotating would just burn quota.
        logger.error(`Gemini key ${pos} rejected the request (400 bad request): ${errText}`);
        err.message = errText;
        throw err;
      }

      if (status === 401 || status === 403 || status === 400) {
        // 400 here is the key-invalid variant (see isInvalidKey400 above).
        slot.disabled = true; // process lifetime — a revoked key never recovers
        logger.warn(`Gemini key ${pos} is INVALID or REVOKED (${status}) — disabled for this process, failing over`);
        break; // next key
      }

      if (status === 429) {
        const daily = isDailyQuota(err);
        slot.coolingUntil = Date.now() + (daily ? msUntilNextUtcDay() : SHORT_COOLDOWN_MS);
        logger.warn(
          `Gemini key ${pos} hit a quota/rate limit (429, ${daily ? "daily — cooling down until next day" : "short — cooling down ~60s"}); trying next key`
        );
        break; // next key
      }

      if (isTransient(err, status)) {
        if (attempt < TRANSIENT_RETRIES) {
          logger.warn(`Gemini key ${pos} unavailable (${errText}); retrying once in ${TRANSIENT_RETRY_BACKOFF_MS}ms`);
          await sleep(TRANSIENT_RETRY_BACKOFF_MS);
          continue; // same key, one short backoff retry
        }
        logger.warn(`Gemini key ${pos} still unavailable after retry; trying next key`);
        break; // next key
      }

      // Unknown failure class — do not guess, hand it to the caller.
      logger.error(`Gemini key ${pos} failed with an unclassified error: ${errText}`);
      err.message = errText;
      throw err;
    }
  }

  const exhausted = new Error(ALL_KEYS_EXHAUSTED_MESSAGE);
  exhausted.geminiKeysExhausted = true;
  exhausted.status = 503;
  logger.warn(`All ${total} Gemini key(s) exhausted, cooling down or disabled — surfacing quota/busy error to the OCR caller`);
  throw exhausted;
};

// ── Test-only helpers (never used by app code) ──────────────────────────────
const __resetGeminiPoolForTesting = () => {
  pool = null;
  roundRobinCursor = 0;
};

// Pool state without key material — only the fields failover tests need.
const __getPoolStateForTesting = () =>
  (pool || []).map((s) => ({ disabled: s.disabled, coolingUntil: s.coolingUntil }));

module.exports = {
  callGemini,
  ALL_KEYS_EXHAUSTED_MESSAGE,
  __resetGeminiPoolForTesting,
  __getPoolStateForTesting,
};
