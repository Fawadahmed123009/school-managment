/**
 * Shared OpenRouter API wrapper with multi-key failover.
 *
 * Every OpenRouter call in the app (marks OCR, fees OCR, future features) goes
 * through callOpenRouter() below — failover/cooldown logic lives here only,
 * never duplicated per service. Replaces the former Gemini wrapper; the OCR
 * model is NVIDIA Nemotron 3.5 Super VL on OpenRouter's free tier.
 *
 * Configuration:
 *   OPENROUTER_API_KEYS  comma-separated list (used first, if present)
 *   OPENROUTER_API_KEY   single key — used when OPENROUTER_API_KEYS is absent
 *   OPENROUTER_MODEL     optional model override (defaults to the free-tier
 *                        nvidia/nemotron-3.5-super-vl:free vision model)
 *
 * Transport: OpenRouter's OpenAI-compatible POST /api/v1/chat/completions via
 * the built-in fetch (Node >= 18) — no SDK dependency. Images are sent as
 * data-URL image_url parts; the reply is normalized to { text } so callers
 * parse exactly as before.
 *
 * Failover rules (same contract as the previous provider, mapped to
 * OpenRouter's HTTP semantics):
 *   429  → mark the key cooling down (~60s per-minute limit; until next UTC
 *          day when the error text names the DAILY free-model quota, or the
 *          X-RateLimit-Reset header points further out) and immediately try
 *          the next key.
 *   402  → credits/balance blocked (account-level, won't recover soon) — cool
 *          down until the next UTC day, then try the next key.
 *   5xx / overloaded / timeout → one short retry with backoff on the SAME key,
 *          then move to the next key.
 *   400  → do NOT rotate (it would fail identically on every key) — throw.
 *          Exception: a 400 whose text names an invalid API key is treated as
 *          the 401/403 case below.
 *   401 / 403 → mark the key disabled for the process lifetime, log loudly,
 *          move on.
 *   Any other error → throw unchanged (don't guess at unfamiliar failures).
 *
 * Keys are never logged or returned — only their position ("key 2/3"). Error
 * messages leaving this module are redacted for any configured key string.
 *
 * State is in-memory (cooldown timestamps, disabled flags, round-robin cursor).
 * Callers: utils/openRouterClient.callOpenRouter({ prompt, mimeType,
 * imageData }) → { text } (the model's message content), or throws. When every
 * usable key is exhausted the thrown error carries geminiKeysExhausted=true
 * (legacy flag name kept so OCR error handlers stay unchanged) and
 * ALL_KEYS_EXHAUSTED_MESSAGE, which OCR services surface to the UI as a 503
 * with that message.
 */
const logger = require("../config/logger");

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";
const REQUEST_TIMEOUT_MS = 120 * 1000; // free-tier vision calls can be slow

const ALL_KEYS_EXHAUSTED_MESSAGE = "OCR quota reached or service busy — try again in a minute";

const SHORT_COOLDOWN_MS = 60 * 1000; // per-minute rate limits
const TRANSIENT_RETRY_BACKOFF_MS = 1000; // one short retry before failing over
const TRANSIENT_RETRIES = 1; // same-key attempts after the first (5xx/timeout)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Lazily built from env so tests (and rotated .env values) take effect without
// a reload of the whole module graph.
let pool = null; // [{ key, disabled, coolingUntil }]
let roundRobinCursor = 0;

// Injectable HTTP transport (test-only seam). Returns { status, headers, body }
// where headers is a plain lowercase-key object and body is the raw text.
let transport = null;

const resolveKeys = () => {
  const multi = String(process.env.OPENROUTER_API_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const single = String(process.env.OPENROUTER_API_KEY || "").trim();
  return single ? [single] : [];
};

const getPool = () => {
  const keys = resolveKeys();
  // Rebuild if the configured key set changed (env reload) — positions and
  // cooldowns reset, which is correct when the keys themselves change.
  const current = pool && pool.map((s) => s.key);
  if (!pool || current.length !== keys.length || current.some((k, i) => k !== keys[i])) {
    pool = keys.map((key) => ({ key, disabled: false, coolingUntil: 0 }));
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

const defaultTransport = async ({ url, method, headers, body, timeoutMs }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    const headerObj = {};
    res.headers.forEach((value, name) => {
      headerObj[name.toLowerCase()] = value;
    });
    return { status: res.status, headers: headerObj, body: text };
  } finally {
    clearTimeout(timer);
  }
};

// OpenRouter errors arrive as { error: { code, message, metadata } } — lift
// them into an Error carrying the HTTP status so the failover rules can branch.
const errorFromResponse = (status, bodyText) => {
  let message = bodyText || `OpenRouter request failed (HTTP ${status})`;
  let code = status;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && parsed.error) {
      if (parsed.error.message) message = String(parsed.error.message);
      if (typeof parsed.error.code === "number") code = parsed.error.code;
    }
  } catch {
    // Non-JSON body (proxy/CDN error page) — keep the raw text, truncated.
    message = String(message).slice(0, 500);
  }
  return Object.assign(new Error(message), { status: code });
};

const TRANSIENT_CODES = ["ETIMEDOUT", "ECONNABORTED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"];

const isTransient = (err, status) => {
  if (status === 503 || status === 500 || status === 502 || status === 504) return true;
  if (err?.name === "AbortError") return true; // our own request timeout
  const msg = String(err?.message || "").toLowerCase();
  if (TRANSIENT_CODES.includes(err?.code)) return true;
  return /overload|unavailable|timeout|timed out|socket hang up|fetch failed/.test(msg);
};

// 429 covers both the per-minute free-tier cap and the daily free-model quota.
// OpenRouter's daily-limit text names the day window; anything ambiguous gets
// the short cooldown and is retried sooner (prefer the short window).
const isDailyQuota = (err) => {
  const msg = String(err?.message || "");
  return /per\s*day|daily|per-day|\bday\b.{0,40}quota|quota.{0,40}\bday\b/i.test(msg);
};

// X-RateLimit-Reset (ms since epoch) accompanies OpenRouter's own free-model
// 429s — when it points further out than the message heuristic, trust it.
const resetHeaderUntil = (headers) => {
  const raw = Number(headers?.["x-ratelimit-reset"]);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  // Guard against a provider sending seconds instead of milliseconds.
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return ms > Date.now() ? ms : 0;
};

// A 400 whose text names an invalid API key is a disable-and-rotate signal
// (defensive carry-over); a genuine bad-request 400 still must not rotate.
const isInvalidKey400 = (err) => {
  const msg = String(err?.message || "");
  return /api[ _.-]?key/i.test(msg) && /not valid|invalid|revoked|expired|deactivated|disabled/i.test(msg);
};

const msUntilNextUtcDay = () => {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 1);
  return next - now.getTime();
};

// OpenAI-compatible chat payload: one user turn carrying the prompt plus the
// scan as a base64 data-URL image part.
const buildPayload = ({ prompt, mimeType, imageData, model }) => ({
  model: model || process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageData}` } },
      ],
    },
  ],
});

/**
 * Call OpenRouter chat completions with key failover. Returns { text } (the
 * model's message content) or throws:
 *  - the original error for 400 / unknown failures (message redacted),
 *  - an Error with geminiKeysExhausted=true + ALL_KEYS_EXHAUSTED_MESSAGE when
 *    no usable key could complete the request.
 */
const callOpenRouter = async ({ prompt, mimeType, imageData, model }) => {
  const slots = getPool();
  if (!slots.length) {
    // Fail loudly — an empty result here would look like a successful scan.
    throw new Error("OCR is not configured: no OpenRouter API key found (set OPENROUTER_API_KEYS or OPENROUTER_API_KEY)");
  }

  const payload = buildPayload({ prompt, mimeType, imageData, model });
  const body = JSON.stringify(payload);
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
      let response;
      try {
        const headers = {
          Authorization: `Bearer ${slot.key}`,
          "Content-Type": "application/json",
        };
        // Optional OpenRouter attribution headers (app ranking/analytics).
        if (process.env.APP_URL) headers["HTTP-Referer"] = process.env.APP_URL;
        if (process.env.SCHOOL_NAME) headers["X-Title"] = process.env.SCHOOL_NAME;

        response = await (transport || defaultTransport)({
          url: OPENROUTER_CHAT_URL,
          method: "POST",
          headers,
          body,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch (e) {
        err = e;
      }

      if (!err && response.status >= 400) {
        err = errorFromResponse(response.status, response.body);
      }

      if (!err) {
        // Success — normalize to the { text } contract the OCR services parse.
        let parsed;
        try {
          parsed = JSON.parse(response.body);
        } catch {
          err = new Error("OpenRouter returned a non-JSON success response");
        }
        if (!err) {
          if (parsed?.error) {
            // Some providers surface errors inside a 200 body.
            err = Object.assign(new Error(String(parsed.error.message || "OpenRouter provider error")), {
              status: typeof parsed.error.code === "number" ? parsed.error.code : 502,
            });
          } else {
            const text = parsed?.choices?.[0]?.message?.content;
            if (typeof text === "string" && text.length) return { text };
            // Fail loudly — an empty result would look like a successful scan.
            err = new Error("OpenRouter returned an empty completion (no message content)");
          }
        }
      }

      const status = typeof err?.status === "number" ? err.status : undefined;
      const errText = redactKeys(String(err?.message || err));

      if (status === 400 && !isInvalidKey400(err)) {
        // Bad request fails on every key — rotating would just burn quota.
        logger.error(`OpenRouter key ${pos} rejected the request (400 bad request): ${errText}`);
        err.message = errText;
        throw err;
      }

      if (status === 401 || status === 403 || status === 400) {
        // 400 here is the key-invalid variant (see isInvalidKey400 above).
        slot.disabled = true; // process lifetime — a revoked key never recovers
        logger.warn(`OpenRouter key ${pos} is INVALID or REVOKED (${status}) — disabled for this process, failing over`);
        break; // next key
      }

      if (status === 429) {
        const resetUntil = resetHeaderUntil(response?.headers);
        const daily = isDailyQuota(err) || resetUntil > Date.now() + SHORT_COOLDOWN_MS;
        slot.coolingUntil = resetUntil || Date.now() + (daily ? msUntilNextUtcDay() : SHORT_COOLDOWN_MS);
        logger.warn(
          `OpenRouter key ${pos} hit a quota/rate limit (429, ${daily ? "daily — cooling down until next day" : "short — cooling down ~60s"}); trying next key`
        );
        break; // next key
      }

      if (status === 402) {
        // Credits/balance blocked — account-level, retrying today is pointless.
        slot.coolingUntil = Date.now() + msUntilNextUtcDay();
        logger.warn(`OpenRouter key ${pos} is credit-blocked (402) — cooling down until next day; trying next key`);
        break; // next key
      }

      if (isTransient(err, status)) {
        if (attempt < TRANSIENT_RETRIES) {
          logger.warn(`OpenRouter key ${pos} unavailable (${errText}); retrying once in ${TRANSIENT_RETRY_BACKOFF_MS}ms`);
          await sleep(TRANSIENT_RETRY_BACKOFF_MS);
          continue; // same key, one short backoff retry
        }
        logger.warn(`OpenRouter key ${pos} still unavailable after retry; trying next key`);
        break; // next key
      }

      // Unknown failure class — do not guess, hand it to the caller.
      logger.error(`OpenRouter key ${pos} failed with an unclassified error: ${errText}`);
      err.message = errText;
      throw err;
    }
  }

  const exhausted = new Error(ALL_KEYS_EXHAUSTED_MESSAGE);
  exhausted.geminiKeysExhausted = true; // legacy flag name — OCR handlers key off it
  exhausted.status = 503;
  logger.warn(`All ${total} OpenRouter key(s) exhausted, cooling down or disabled — surfacing quota/busy error to the OCR caller`);
  throw exhausted;
};

// ── Test-only helpers (never used by app code) ──────────────────────────────
const __resetOpenRouterPoolForTesting = () => {
  pool = null;
  roundRobinCursor = 0;
};

// Pool state without key material — only the fields failover tests need.
const __getPoolStateForTesting = () =>
  (pool || []).map((s) => ({ disabled: s.disabled, coolingUntil: s.coolingUntil }));

// Swap the HTTP transport (null restores the real fetch-based one).
const __setTransportForTesting = (fn) => {
  transport = fn;
};

module.exports = {
  callOpenRouter,
  DEFAULT_MODEL,
  ALL_KEYS_EXHAUSTED_MESSAGE,
  __resetOpenRouterPoolForTesting,
  __getPoolStateForTesting,
  __setTransportForTesting,
};