# Security Audit Remediation Queue

Tracks the C*/H* findings from the security audit, in the agreed working order.
Update status as each is fixed and committed.

## Completed

- **C1** — restrict admin-account management + lock `GET /admins` roster read to
  full admins. ✅ committed
- **C2** — re-check teacher suspension on every request; soft-delete fee records
  and audit every fee mutation. ✅ committed
- **C3** — XSS in the OCR / import review UIs: escape all user-controlled data
  (spreadsheet cells, Gemini extract/error text, stored names) before it reaches
  `innerHTML`. Shared `public/js/escape-html.js` escaper wired into the fees OCR,
  marks OCR and student-import review pages. ✅ committed
  (`fix(security C3)`, tests in `__tests__/c3XssReview.test.js`)
- **H1** — enforce a unique email per account collection. ✅ committed
- **H2** — trim the signed `session` cookie to `{_id, name, role}` so the full
  user document (password hash, contact/fee fields) is never handed to the
  client. `utils/sessionCookie.js` whitelist; role/manager/suspension stay
  DB-resolved in `authView`. ✅ committed
  (`fix(security H2)`, tests in `__tests__/h2CookieTrim.test.js`)
- **H2 — post-fix exposure check (CLOSED, no further action).** Confirmed on
  2026-09-25 that no logging/proxy/analytics tool in the stack could have
  captured the pre-fix cookie value (which contained the bcrypt hash):
  - **Morgan** (`combined` in prod / `dev` locally) — formats confirmed from
    the installed morgan source; neither emits request headers, so the `Cookie`
    header is never written. `dev` format doesn't even log the URL.
  - **Winston** (`config/logger.js`) — file transports only (`logs/`, console in
    dev); no external transport (no Loggly/Datadog/Sentry…). `errorHandler`
    logs only `{method, url, ip, stack}` — no headers/cookies.
  - **No analytics / error-tracking SDKs** — grep across views and `public/js`
    for gtag/GA/Firebase/Sentry/Datadog/New Relic/Segment/Mixpanel/Hotjar etc.
    found nothing; the only third-party script in the page is Chart.js from
    jsdelivr (a CDN asset loader, cannot see request headers).
  - **Log forensics** — `grep` over `logs/combined.log` + `logs/error.log`:
    0 occurrences of the session cookie (`session=s%3A` / `s%3A{`) and 0
    occurrences of bcrypt hash markers (`$2a$/$2b$`). No `crash.log` exists.
  - **Proxy/deploy path** — the stack includes no in-repo proxy that logs
    headers; `trust proxy` is set only so `req.ip` resolves for rate-limiting
    (this is an *input* to the app, not a capture surface). Residual caveat:
    cPanel/Passenger host-side Apache logs live outside the repo and were not
    swept; standard cPanel LogFormat does not include `%{Cookie}i`, and no
    change is pending on that basis.
  Conclusion: the pre-fix cookie existed only in the client's own cookie jar
  (its intended audience); nothing server-side in the stack retained it.
  Combined with H2 already committed and Cookie Hashing being non-reversible,
  H2 is closed with **no further action** (no forced rotation required).

## Housekeeping (done alongside C3)

- Deleted ungoverned root reset scripts: `_reset_all_pw.js` (mass reset, hardcoded
  password + localhost DB) and `_reset_student.js` (same class). Both were
  git-ignored (`/_*.js`), never tracked, nothing depended on them.
- Relocated the one worthwhile bootstrap into tracked `scripts/createFirstAdmin.js`
  (env/prompt password, runs app `validatePassword`, hard localhost-only guard —
  verified it REFUSES an Atlas connection string before any write).

## Remaining — work in this order

- **H3** — ✅ DONE (2026-09-25): rate-limiter lockout + XFF bypass on the login
  surfaces. Limiters moved to `middlewares/rateLimiters.js`:
  - **XFF bypass** — bucket keys are no longer express-rate-limit's default
    `req.ip` (client-spoofable under `trust proxy, 1`). `resolveClientIp`
    honors XFF only while the raw socket peer is loopback/private (an on-box
    conforming proxy that APPENDS its observed address; client = chain entry
    `length - hops`, chains shorter than `hops` clamp to the socket). A PUBLIC
    socket peer is always authoritative → Internet-side XFF rotation is inert.
    `TRUST_PROXY_HOPS` env drives both `app.set("trust proxy", …)` and the key
    derivation; `=0` ignores XFF completely (direct exposure). Remaining known
    limit (documented): a LOCAL process can forge a well-formed 1-entry chain
    — contained by per-account keying; set hops=0 if dev must hard-throttle.
  - **Lockout** — login budget is per **{ip + account}** (5-min window, 10
    failed attempts, env-tunable), successful requests never consume it
    (`skipSuccessfulRequests`), and the limiter now covers BOTH credential
    surfaces: the API routes and the browser form `POST /login` (previously
    only globally limited). The global limiter (2000/15min, env-tunable)
    additionally skips `/uploads/` and `/reports/pdf/` asset traffic so a
    shared-NAT school can't be self-locked-out by normal browsing. Body
    parsing now runs before the limiters (account key must exist).
  - Tests: `__tests__/rateLimitersH3.test.js` (16, incl. real-HTTP bucket
    tests). Live verification: `tmp/_verify_h3_rate_limiters.js` — form
    `/login` + API login carry RateLimit headers, account A throttles at 429
    after 10 failures, account B on same IP unaffected, pages healthy.
- **H4** — pending (per original audit queue).
- **H5** — pending (per original audit queue).
- **H6** — ✅ DONE (2026-09-25): the multi-step bulk-assign and generate-monthly-
  fees flows (and the OCR bulk-confirm loop, same partial-write shape) are now
  wrapped in MongoDB transactions. `withTransaction` helper in
  `services/fees/fees.service.js`: session + majority-writeConcern transaction,
  one retry on `UnknownTransactionCommitResult`, abort-then-rethrow on any
  mid-loop failure; on deployments without session support (standalone mongod)
  it degrades transparently to the previous non-transactional execution.
  - `bulkCreateFeesService` — the whole match/save/create + audit loop runs in
    ONE transaction; a failure at row *k* rolls back rows 1..k-1 entirely.
    All reads (pending-fee queries), `fee.save`, `Fees.create` and audit writes
    are session-bound.
  - `bulkAssignFeesService` — `insertMany` + its aggregate audit row commit (or
    roll back) atomically: an untracked bulk assignment can no longer exist.
  - `generateMonthlyFeesService` — same pairing for the generated rows + audit
    row; the no-rows case opens no transaction.
  - Single-document paths (`createFee`/`updateFee`/`deleteFee`) keep their
    existing compensating-rollback (both writes are atomic per doc); noted in
    the code. `writeFeeAudit` moved to the array form `create([entry], opts)`.
  - Tests: `__tests__/feeTransactionsH6.test.js` (9: session threading, abort
    on mid-loop failure, commit pairing, standalone degrade, no-op skip).
    Live verification: `tmp/_verify_h6_transactions.js` against the real Atlas
    replica set — abort persisted 0 of 2 writes, commit persisted 2 of 2,
    self-read of uncommitted write OK.

## Follow-ups (schedule AFTER H3–H6 — not urgent enough to reorder the queue)

These were flagged during the password-policy / audit work but are deliberately
queued behind H3–H6:

1. **validatePassword not wired on the teacher write path** — teacher create /
   password-update should run the same policy every other write enforces.
2. **validatePassword not wired on the student write path** — student create /
   password set (incl. the promoted/imported accounts).
3. **validatePassword not wired on the parent write path** — parent create /
   password-update.
4. **Weak temp-password generation in student import** — the bulk import issues
   low-entropy temporary passwords; strengthen the generator (and the
   student-login credential handoff) once the above paths validate.

Related note: the current policy minimum is **6 characters**. Whether to raise
the floor is folded into items 1–4 (it only makes sense to bump the minimum at
the same time the gaps above are closed, so every write path moves together).
