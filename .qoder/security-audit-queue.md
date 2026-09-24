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

## Housekeeping (done alongside C3)

- Deleted ungoverned root reset scripts: `_reset_all_pw.js` (mass reset, hardcoded
  password + localhost DB) and `_reset_student.js` (same class). Both were
  git-ignored (`/_*.js`), never tracked, nothing depended on them.
- Relocated the one worthwhile bootstrap into tracked `scripts/createFirstAdmin.js`
  (env/prompt password, runs app `validatePassword`, hard localhost-only guard —
  verified it REFUSES an Atlas connection string before any write).

## Remaining — work in this order

- **H3** — pending (per original audit queue).
- **H4** — pending (per original audit queue).
- **H5** — pending (per original audit queue).
- **H6** — ⚠️ **STILL OPEN.** The multi-step bulk-assign and generate-monthly-fees
  flows were **not** wrapped in transactions by the C2 fee work. C2 added
  soft-delete + audit trails (`services/fees/fees.service.js`) but introduced no
  `startSession` / `withTransaction`; those partial-write paths (create many fee
  rows + audit rows across loops) can still leave inconsistent state on a
  mid-loop failure. To be addressed as part of H6.

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
