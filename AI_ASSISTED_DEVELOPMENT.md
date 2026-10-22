# AI-Assisted Development Report — School Management System

**Document type:** Technical / process report
**Subject:** How this project was designed, built, hardened and maintained using AI coding tools, and which tools were used.
**Repository:** `school-management-system` (Node.js / Express / MongoDB backend + server-rendered EJS portal)

---

## 1. Executive summary

This system is a production single-tenant school-management platform (students, parents, staff, academic sessions/tests, marks, fees, analytics, PDF reports, OCR mark entry, WhatsApp sharing, PWA). It began as an open-source Node/Express school-management scaffold and was then **substantially extended, refactored and security-hardened through an AI-assisted development workflow**.

The development was carried out almost entirely with **agentic AI coding tools** operating directly against the repository and a live dev server, rather than through manual typing. The AI tools planned features, wrote service/controller/route/view/test code, ran the test suite, drove a live HTTP browser against the running server to verify behaviour, performed a structured security audit, and committed work in logical units.

This report documents the **toolchain**, the **repeatable workflow**, the **artifacts the AI left in the repo**, the **quality guardrails**, and a **first-hand case study** (the Combined-subject analytics feature) to illustrate how a change moves from request to committed, verified code.

---

## 2. AI tooling used

| Tool / surface | Role in the project | Evidence in the repo |
|---|---|---|
| **Qoder** (agentic AI coding assistant + IDE) | Primary day-to-day builder: feature implementation, refactors, regression tests, security remediation, long-term memory of conventions. | `.qoder/` directory: `plans/`, `security-audit-queue.md`, `audit-fixes-completed.md`; the persistent memory system (user/project/dev-spec/experience categories). |
| **Claude Code** (terminal AI agent) | Parallel/earlier agentic sessions for command-driven work: syntax gates, test runs, live `curl` probes, file surgery, server control. | `.claude/` directory: `settings.local.json` (permission allowlist of approved Bash commands), `launch.json`, `cpicker-harness.html`, `cpicker-preview-server.js`. |
| **Gemini** (Google Generative AI) | A **product feature** of the app, *not* a dev tool: OCR of marked answer sheets and analytics/insight text. Wired through a shared client wrapper with API-key failover. | `@google/genai` dependency, `services/.../*ocr*`, `utils/geminiClient` wrapper, OCR views/tests (`__tests__/ocr*`). |

> **Important distinction:** Gemini is the application's *runtime* AI capability (reading scanned marks). The *development* AI is the agentic coding tools (Qoder / Claude Code) that wrote and verified the code. They are unrelated roles.

### 2.1 Operating environment

- **Host → guest execution:** the developer works on Windows and drives a **WSL Ubuntu** guest (`wsl -d ubuntu -- bash -lc …`). The `.claude/settings.local.json` allowlist is full of these prefixed commands, which is a fingerprint of the AI-approval workflow: every recurring shell action is pre-registered so the agent can run it without re-prompting.
- **Runtime:** Node.js, dev server on **port 5130**, **MongoDB Atlas** (remote) via `DB` env var; `PORT`, `JWT_SECRET_KEY`, `COOKIE_SECRET`, `SCHOOL_NAME`, `GEMINI_API_KEY` in `.env`.

---

## 3. The technology stack the AIs worked within

The agents authored code against this fixed stack (from `package.json`):

- **Server:** Express 4, `app/app.js`, `server.js`, modular routers under `routes/v1/...` (API, Bearer JWT) and `routes/views/...` (server-rendered portal, signed session cookie).
- **Data:** MongoDB + Mongoose; layered `models/ → services/ → controllers/ → routes/`; MVC with a service layer doing the real logic.
- **Views:** EJS (`views/**`, shared partials incl. a unified filter-cascade).
- **Auth/security:** JWT + `bcryptjs`, `cookie-parser` signed cookies, `helmet`, `cors`, `express-mongo-sanitize`, `express-rate-limit`, `express-validator`, a synchronizer-token CSRF layer (`middlewares/csrf.js`).
- **Reports/media:** `pdfkit` (+ shared card-style primitives), `puppeteer`-driven flows, `sharp` image handling, `docx` + `xlsx` import/export, Cloudflare R2 / S3 (`@aws-sdk/client-s3`) for photos.
- **Frontend behaviour:** vanilla client JS in `public/js` + Chart.js; PWA (`manifest.json`, `sw.js`).
- **Testing / tooling:** **Jest** (80 suites, **1086 tests** at the time of writing), `nodemon`, `winston`/`morgan` logging.

---

## 4. The AI development workflow (repeated loop)

Every substantial change followed the same disciplined loop, which the tools' memories and audit files codify:

1. **Clarify intent** — where a request is ambiguous or has multiple valid designs, the agent surfaces the choice (e.g. an option-based question) before writing code, rather than guessing.
2. **Investigate the codebase first** — semantic search + symbol search + reading the actual files, and retrieving project conventions from the persistent memory, so new code matches existing architecture.
3. **Plan the change set** — enumerate the files touching service / controller / router / view / client JS / tests.
4. **Implement in dependency order** — data/logic layer first, then routes, then views, then client wiring.
5. **Guard syntax** — `node --check` across touched files (a standing allowlisted batch command in `.claude`).
6. **Add/refresh Jest coverage** — models are mocked at the data layer so the *real* service logic executes; a green full-suite run is required before considering the work done.
7. **Live verification against the running server** — the agent restarts the dev server (`tmp/restart_server.sh`) and exercises the actual routes, often by **minting a signed session cookie** with a throwaway script and hitting real endpoints / generating and inspecting real PDF bytes. This is the project's standing rule that security and behaviour fixes must be *proven live*, not just unit-tested.
8. **Clean up probe artifacts** — temporary `_verify_*.js` / `_e2e_*.js` scripts are deleted (and are gitignored) so the tree stays clean.
9. **Persist learnings** — reusable conventions, pitfalls and decisions are captured in the memory system so future sessions stay consistent.
10. **Commit in logical units** — conventional-commit messages (`feat(scope): …`, `fix(security H2)`, etc.), no unrelated changes swept in, hooks never skipped.

---

## 5. Security audit as an AI-led workstream

The repo contains the artifacts of a **two-phase AI security audit and remediation**:

- `.qoder/security-audit-queue.md` — a prioritised queue of findings labelled by severity (`C1…C3` critical, `H1…H5` high, `N…`, `D…`, `A…`), each tracked to "✅ committed".
- `.qoder/audit-fixes-completed.md` — completion log.

Examples of AI-hardened outcomes recorded there:

- **Session cookie trimmed** to `{_id, name, role}` so a password hash / PII never reaches the client; identity re-resolved from the DB on every request (`authView`).
- **Teacher-suspension** re-checked per request; **fail-closed** guards so an ambiguous scope can never widen to a school-wide query.
- **XSS** eliminated in OCR/import review UIs via a shared `escape-html.js` applied before any `innerHTML`.
- **CSRF** synchronizer-token layer over the cookie portal; unique-email enforcement; rate limits; upload limits.
- Each finding ships with a dedicated regression test (`__tests__/csrf.test.js`, `h2CookieTrim.test.js`, `c3XssReview.test.js`, `rateLimitersH3.test.js`, `suspendedTeacherAccess.test.js`, …).

The audit files also record **negative evidence** — the AI grepped logs, inspected `morgan`/`winston` transports, and confirmed no analytics/SDK could have leaked pre-fix secrets. This "prove the impact, then close the finding" discipline is characteristic of the workflow.

---

## 6. Case study (first-hand): "Combined-subject analytics"

A representative end-to-end change, to show the loop in practice:

**Request:** on the Analytics page, when analysing multiple tests of the same subject, show a combined average/min/max, and add a PDF download of that analysis plus the marks list.

**Ambiguity resolved first:** the agent asked three design questions and locked them down —
- *Test selection* → subject + "All tests" (reuses the existing unified cascade).
- *Metric basis* → **percent-normalised** pooling (each attempt converted to `score ÷ totalMarks × 100` before combining, so tests with different totals stay comparable; absences excluded).
- *Delivery* → a dedicated "Download PDF" button on the page reusing the existing card-PDF primitives.

**Follow-up refinement:** the user then specified that Highest/Lowest should be the *best/worst pupil's own overall average*, not a single attempt score. The agent re-derived `pooled.max/min` from the per-pupil overall percentages in the **shared builder**, so the on-screen cards and the PDF could not disagree.

**Files the AI produced (all verified):**

- `services/academic/test.service.js` — `buildCombinedSubjectData` (single source of truth) + `getCombinedSubjectAnalyticsService` + percent helpers.
- `controllers/academic/test.controller.js`, `routes/v1/academic/test.router.js` — `GET /tests/analytics/combined` (admin/manager).
- `services/academic/pdfReport.service.js` + `controllers/academic/pdfReport.controller.js` + `routes/v1/academic/pdfReport.router.js` — `generateCombinedSubjectPdf` reached via `POST /pdf-reports/analytics-combined`.
- `routes/views/testAnalytics.views.js` — the Combined view-mode branch + a **CSRF-exempt GET** `/tests/analytics/pdf` download route.
- `views/tests/analytics.ejs` — the Combined mode UI + download button.
- `__tests__/combinedSubjectAnalytics.test.js` — new; `__tests__/analyticsCascade.test.js` — updated wiring assertion.

**Verification the AI ran:**
- Full Jest suite green (1086 tests).
- Server restarted; a **throwaway script minted an admin session cookie** and fetched the real routes against a live subject with 10 tests — confirmed the page rendered and the PDF endpoint returned valid `%PDF-` bytes served at an opaque UUID URL.
- Temp scripts deleted; work committed as one conventional commit (`feat(analytics): …`) that also swept in the branch's pre-existing checkpoint changes, with an honest message describing both.

This single feature demonstrates the recurring pattern: *clarify → reuse existing conventions → implement in layers → unit test → prove live → clean → commit.*

---

## 7. Division of labour

- **Human (product owner / developer):** defines requirements, makes the design trade-off decisions (the agent presents options), owns credentials and the live environment, and reviews outcomes.
- **AI agents:** code comprehension across a large repo, drafting and editing service/controller/route/view/test code, running syntax gates and the full test suite, driving the live server to verify behaviour and PDF output, executing the structured security audit, keeping a persistent memory of project conventions, and producing conventional commits.

---

## 8. Guardrails and conventions the AI followed

- **Architecture fit before novelty:** new code matches the existing `model → service → controller → route → view` layering and reuses shared utilities (cascade partial, card-PDF primitives, `apiClient`, `responseStatus`).
- **Fail-closed scoping** and **DB-resolved identity** (never trust token/cookie role claims).
- **Read-only where possible** (`.lean()`, scoped queries) and N+1 avoidance.
- **No secret leakage** — session payload minimised; credentials never stored in memory artifacts.
- **Green tests + live proof** are the definition of "done".
- **Clean tree** — throwaway probes are gitignored and removed.

---

## 9. Reproducing this AI-assisted setup

1. Clone the repo, `npm install`, configure `.env` (from `.env.example`) with `DB`, `PORT`, `JWT_SECRET_KEY`, `COOKIE_SECRET`, `GEMINI_API_KEY`.
2. Create the first admin (`node scripts/createFirstAdmin.js`) and start the dev server (`bash tmp/restart_server.sh`).
3. Open the project in an agentic AI coding tool (Qoder / Claude Code). Pre-approve the recurring shell commands (server restart, `node --check`, `npx jest`, live `curl`/cookie probes) so the agent can run them autonomously.
4. Adopt the loop in §4: investigate → clarify → implement → `node --check` → Jest → live verify → clean → commit.
5. Keep the memory/audit artifacts current so each session inherits the conventions.

---

## 10. Limitations and notes

- The project started from a third-party open-source scaffold; this report covers the **AI-driven extension and hardening** layered on top, not the original authorship.
- "AI tools" here means **agentic coding assistants**; the app's own Gemini usage is a runtime feature and is called out separately to avoid conflating the two.
- Live verification relies on a reachable dev server and MongoDB Atlas; CI environments without a live server fall back to the Jest suite plus spawned-process proofs.

---

*Prepared as a factual process record derived from the repository's own tooling artifacts, dependency manifest, test suite and the documented workflow conventions.*
